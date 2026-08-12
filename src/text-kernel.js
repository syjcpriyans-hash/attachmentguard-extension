/**
 * AttachmentGuard Text Kernel v1
 *
 * Pure character-stream algorithms. No DOM and no PDFium dependency here.
 * PDFium extraction is performed by viewer.js and passed into this module.
 */

export class KernelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "KernelError";
    this.code = code;
  }
}

const arr = s => Array.from(String(s ?? ""));

export function unionBounds(items) {
  return {
    left: Math.min(...items.map(x => x.box.left)),
    bottom: Math.min(...items.map(x => x.box.bottom)),
    right: Math.max(...items.map(x => x.box.right)),
    top: Math.max(...items.map(x => x.box.top)),
  };
}

function charWidth(c) {
  return Math.max(0.25, c.box.right - c.box.left);
}

function sameBaseline(a, b) {
  const ah = Math.max(.25, a.box.top - a.box.bottom);
  const bh = Math.max(.25, b.box.top - b.box.bottom);
  const overlap = Math.max(0, Math.min(a.box.top, b.box.top) - Math.max(a.box.bottom, b.box.bottom));
  const overlapRatio = overlap / Math.min(ah, bh);
  const ac = (a.box.top + a.box.bottom) / 2;
  const bc = (b.box.top + b.box.bottom) / 2;
  return overlapRatio >= .45 || Math.abs(ac - bc) <= Math.max(1.2, Math.min(ah, bh) * .30);
}

function horizontalAngle(angle) {
  if (!Number.isFinite(angle)) return false;
  const twoPi = Math.PI * 2;
  const a = ((angle % twoPi) + twoPi) % twoPi;
  return Math.min(Math.abs(a), Math.abs(twoPi - a)) <= 0.06;
}

function geometricWordBreak(prev, cur) {
  if (!sameBaseline(prev, cur)) return true;

  // If characters belong to the same PDF object and there is no explicit
  // whitespace character between them, keep them together.
  if (prev.objIndex === cur.objIndex) return false;

  const gap = cur.box.left - prev.box.right;
  if (gap < -Math.max(1, Math.min(charWidth(prev), charWidth(cur)) * .4)) return true;

  const typical = Math.max(.35, Math.min(charWidth(prev), charWidth(cur)));
  const size = Math.max(1, Math.min(prev.fontSize || 10, cur.fontSize || 10));
  const threshold = Math.max(.75, Math.min(3.2, typical * .62, size * .24));
  return gap > threshold;
}

function buildSlices(chars) {
  const byObject = new Map();
  for (const c of chars) {
    if (c.objIndex == null || c.objOffset == null) continue;
    if (!byObject.has(c.objIndex)) byObject.set(c.objIndex, []);
    byObject.get(c.objIndex).push(c);
  }

  const slices = [];
  for (const [objIndex, members] of byObject) {
    members.sort((a,b) => a.objOffset - b.objOffset);
    const offsets = members.map(x => x.objOffset);
    const contiguous = offsets.every((v,i) => i === 0 || v === offsets[i-1] + 1);
    slices.push({
      objIndex,
      start: offsets[0],
      end: offsets[offsets.length - 1] + 1,
      contiguous,
      streamStart: Math.min(...members.map(x => x.streamIndex)),
      members,
    });
  }
  return slices.sort((a,b) => a.streamStart - b.streamStart);
}

function finalizeWord(chars) {
  if (!chars.length) return null;
  const text = chars.map(c => c.unicode).join("");
  const styleKeys = [...new Set(chars.map(c => c.styleKey).filter(Boolean))];
  const slices = buildSlices(chars);

  const mapped =
    chars.every(c =>
      c.unicode &&
      !c.generated &&
      c.mapError === 0 &&
      c.objIndex != null &&
      c.objOffset != null &&
      horizontalAngle(c.angle)
    ) &&
    slices.every(s => s.contiguous);

  return {
    text,
    chars: chars.map(c => ({...c, box:{...c.box}, origin:{...c.origin}})),
    bounds: unionBounds(chars),
    slices,
    styleKeys,
    mixedStyle: styleKeys.length > 1,
    editable: mapped && styleKeys.length === 1,
    reason: !mapped
      ? "This word contains generated, unmapped, rotated, or unresolvable PDF characters. Text Kernel v1 will not guess."
      : styleKeys.length > 1
        ? "This word contains mixed formatting. Text Kernel v1 blocks destructive mixed-style rewriting."
        : "",
  };
}

export function segmentWords(characters) {
  const words = [];
  let current = [];

  const flush = () => {
    const word = finalizeWord(current);
    if (word && word.text.trim()) words.push(word);
    current = [];
  };

  for (const c of characters) {
    const ch = c.unicode || "";

    if (!ch || /\s/.test(ch)) {
      flush();
      continue;
    }

    if (current.length && geometricWordBreak(current[current.length - 1], c)) {
      flush();
    }

    current.push(c);
  }
  flush();
  return words;
}

export function planWordReplacement(word, replacement, objectRecords) {
  if (!word?.editable) {
    throw new KernelError("KERNEL_UNSUPPORTED_SELECTION", word?.reason || "Selection is not safely editable.");
  }

  const replacementChars = arr(replacement);
  if (!replacementChars.length) {
    throw new KernelError("KERNEL_EMPTY_REPLACEMENT", "Empty replacement is not supported in Text Kernel v1.");
  }

  if (!word.slices?.length) {
    throw new KernelError("KERNEL_NO_OBJECTS", "No underlying PDF text objects were mapped to this word.");
  }

  const actions = [];

  for (let i=0; i<word.slices.length; i++) {
    const slice = word.slices[i];
    const rec = objectRecords.get(slice.objIndex);
    if (!rec) {
      throw new KernelError("KERNEL_OBJECT_MISSING", `PDF text object ${slice.objIndex} is unavailable.`);
    }

    const oldChars = arr(rec.text);
    if (slice.start < 0 || slice.end > oldChars.length || slice.start >= slice.end) {
      throw new KernelError("KERNEL_OFFSET_MISMATCH", "PDF character offsets do not match the underlying text object.");
    }

    // Only the primary object may contain unrelated prefix/suffix text.
    // Secondary objects must consist entirely of selected word fragments.
    if (i > 0 && (slice.start !== 0 || slice.end !== oldChars.length)) {
      throw new KernelError(
        "KERNEL_COMPLEX_CROSS_OBJECT",
        "This word crosses a PDF object that also contains neighboring unselected text. The kernel blocked a destructive rewrite."
      );
    }

    const insert = i === 0 ? replacementChars : [];
    const next = [
      ...oldChars.slice(0, slice.start),
      ...insert,
      ...oldChars.slice(slice.end),
    ];

    actions.push({
      objIndex: slice.objIndex,
      primary: i === 0,
      oldText: oldChars.join(""),
      newText: next.join(""),
      start: slice.start,
      end: slice.end,
      selectedLength: slice.end - slice.start,
      replacementLength: insert.length,
      fullObjectSelected: slice.start === 0 && slice.end === oldChars.length,
      removeObject: next.length === 0,
    });
  }

  return {
    replacement: replacementChars.join(""),
    actions,
    primary: actions[0],
  };
}
