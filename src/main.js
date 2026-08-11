import { init } from "@embedpdf/pdfium";
import opentype from "opentype.js";
import { vaultCount, vaultList, vaultPut } from "./font-vault.js";
import { attachmentBridge } from "./provider-bridge.js";

const PDFIUM_WASM = chrome.runtime.getURL("assets/pdfium.wasm");
const TEXT = 1, FONT_TRUETYPE = 2, FONT_TYPE1 = 1;
const $ = (id) => document.getElementById(id);
const S = {
  m:null, bytes:null, doc:0, ptr:0, page:0, pages:0, zoom:1, scale:1, pw:0, ph:0,
  objs:[], sel:null, name:"edited.pdf", blob:null, history:[], redo:[], changes:[],
  originalBytes:null, originalName:"", uploadedFont:null, resolvedFont:null,
  engineReady:false, preflight:null, searchMatches:[], searchCursor:-1
};

const subsetRx = /^[A-Z]{6}\+/;
const stripSubset = (s) => (s || "").replace(subsetRx, "");
const norm = (s) => stripSubset(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const codepoints = (s) => Array.from(s);
const cpLabel = (ch) => `${ch === " " ? "SPACE" : ch} (U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4,"0")})`;

function log(x) {
  $("log").textContent = `[${new Date().toLocaleTimeString()}] ${x}\n` + $("log").textContent;
  console.log("[AttachmentGuard]", x);
}
function setBox(id, text, kind="") {
  const e = $(id); e.textContent = text; e.className = `status ${kind}`;
}
function setHealth(text, kind="loading") {
  const e = $("healthBadge"); e.textContent = text; e.className = `health ${kind}`;
}
function timeout(promise, ms, label) {
  let timer;
  const t = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms/1000)}s`)), ms);
  });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}
function rt() {
  const p = S.m.pdfium;
  return {
    malloc:n => { const x = p.wasmExports.malloc(n); if (!x && n) throw Error("PDFium out of memory"); return x; },
    free:x => x && p.wasmExports.free(x),
    heap:() => p.HEAPU8,
    gf:x => p.getValue(x,"float"),
    gi:x => p.getValue(x,"i32"),
    sf:(ptr,v) => p.setValue(ptr,v,"float"),
    u16:x => p.UTF16ToString(x),
    u8:x => p.UTF8ToString(x),
    w16:(s,ptr,n) => p.stringToUTF16(s,ptr,n)
  };
}

async function refreshVaultCount() {
  try {
    const count = await vaultCount();
    if ($("capVault")) $("capVault").textContent = `${count} saved exact font${count===1?"":"s"} ✅`;
  } catch (e) {
    if ($("capVault")) $("capVault").textContent = `Unavailable: ${e.message}`;
  }
}
function showCapabilities() {
  $("capSecure").textContent = window.isSecureContext ? "YES ✅" : "NO ❌";
  $("capWasm").textContent = typeof WebAssembly === "object" ? "YES ✅" : "NO ❌";
  $("capFonts").textContent = "queryLocalFonts" in window ? "SUPPORTED ✅" : "NOT AVAILABLE";
  $("capBrowser").textContent = navigator.userAgent;
  refreshVaultCount();
}

function validWasmHeader(buffer) {
  const b = new Uint8Array(buffer, 0, Math.min(4, buffer.byteLength));
  return b.length === 4 && b[0] === 0x00 && b[1] === 0x61 && b[2] === 0x73 && b[3] === 0x6d;
}

async function engineSelfTest() {
  if (!S.m) throw new Error("PDFium is not initialized");
  const doc = S.m.FPDF_CreateNewDocument();
  if (!doc) throw new Error("FPDF_CreateNewDocument failed");
  let page = 0;
  try {
    page = S.m.FPDFPage_New(doc, 0, 200, 200);
    if (!page) throw new Error("FPDFPage_New failed");
    const count = S.m.FPDF_GetPageCount(doc);
    if (count !== 1) throw new Error(`Self-test page count mismatch: ${count}`);
    return true;
  } finally {
    if (page) S.m.FPDF_ClosePage(page);
    S.m.FPDF_CloseDocument(doc);
  }
}


let mimeCapturePromise = null;

function streamHeader(headers, name) {
  if (!headers || typeof headers !== "object") return "";
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === target) return String(value ?? "");
  }
  return "";
}

async function captureMimeHandlerStream() {
  if (!chrome.mimeHandler?.getStreamInfo) return null;
  let info = null;
  try {
    info = await chrome.mimeHandler.getStreamInfo();
  } catch {
    return null;
  }

  try {
    const response = await fetch(info.streamUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`Chrome PDF stream returned HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { info, bytes };
  } catch (error) {
    return { info, error };
  }
}

mimeCapturePromise = captureMimeHandlerStream();

function pdfHeaderLooksValid(bytes) {
  const n = Math.min(bytes.length, 1024);
  let s = "";
  for (let i=0;i<n;i++) s += String.fromCharCode(bytes[i]);
  return s.includes("%PDF-");
}

function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const raw = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "document.pdf");
    return raw.toLowerCase().endsWith(".pdf") ? raw : `${raw || "document"}.pdf`;
  } catch {
    return "document.pdf";
  }
}

function fileNameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf) {
    try { return decodeURIComponent(utf[1].replace(/^["']|["']$/g,"")); } catch {}
  }
  const plain = header.match(/filename="?([^";]+)"?/i);
  return plain ? plain[1] : fallback;
}

async function loadMimeHandlerPdf(capture) {
  if (!capture?.info) return false;
  if (capture.error) throw capture.error;

  const { info, bytes } = capture;
  if (!bytes?.length || !pdfHeaderLooksValid(bytes)) {
    throw new Error("Chrome supplied a stream that is not a valid PDF document");
  }

  const originalUrl = info.originalUrl || "";
  let fileName = fileNameFromUrl(originalUrl);
  fileName = fileNameFromDisposition(streamHeader(info.responseHeaders, "content-disposition"), fileName);

  $("sourceContext")?.classList.remove("hidden");
  if ($("sourceUrlText")) $("sourceUrlText").textContent = originalUrl || "Chrome PDF stream";
  if ($("sourceLoadStatus")) {
    $("sourceLoadStatus").className = "status ok";
    $("sourceLoadStatus").textContent =
      `Chrome PDF stream captured directly ✅\n${fileName} • ${bytes.length.toLocaleString()} bytes${info.embedded ? " • embedded document" : ""}`;
  }
  if ($("returnToSourceBtn")) {
    $("returnToSourceBtn").textContent = "← Back";
    $("returnToSourceBtn").classList.toggle("hidden", !!info.embedded);
  }
  if (info.embedded) document.body.classList.add("embedded-view");

  S.history=[];S.redo=[];S.changes=[];S.originalBytes=bytes.slice();S.originalName=fileName;
  S.name=fileName.replace(/\.pdf$/i,"")+"-AttachmentGuard.pdf";
  openBytes(bytes);S.page=0;S.zoom=1;clearSearch({keepInputs:false});
  $("docCard").classList.remove("hidden");$("workTools").classList.remove("hidden");
  updateSessionUI();
  await render();

  setBox("engine", `ENGINE PASS ✅\n${fileName} loaded from Chrome's PDF stream — ${S.pages} page(s).`, "ok");
  log(`Chrome MIME PDF loaded: ${originalUrl || "(no original URL)"}`);
  return true;
}

async function loadExtensionSourcePdf(sourceUrl) {
  if (!sourceUrl) return;
  $("sourceContext")?.classList.remove("hidden");
  if ($("sourceUrlText")) $("sourceUrlText").textContent = sourceUrl;
  if ($("sourceLoadStatus")) {
    $("sourceLoadStatus").className = "status";
    $("sourceLoadStatus").textContent = "Loading PDF bytes from the original website…";
  }

  try {
    const response = await fetch(sourceUrl, {
      credentials: "include",
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status} ${response.statusText}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!pdfHeaderLooksValid(bytes)) {
      const type = response.headers.get("content-type") || "(no content-type)";
      throw new Error(`The source did not return a PDF file. Content-Type: ${type}`);
    }

    let fileName = fileNameFromUrl(response.url || sourceUrl);
    fileName = fileNameFromDisposition(response.headers.get("content-disposition"), fileName);

    S.history=[];S.redo=[];S.changes=[];S.originalBytes=bytes.slice();S.originalName=fileName;
    S.name=fileName.replace(/\.pdf$/i,"")+"-AttachmentGuard.pdf";
    openBytes(bytes);S.page=0;S.zoom=1;clearSearch({keepInputs:false});
    $("docCard").classList.remove("hidden");$("workTools").classList.remove("hidden");
    updateSessionUI();
    await render();

    if ($("sourceLoadStatus")) {
      $("sourceLoadStatus").className = "status ok";
      $("sourceLoadStatus").textContent = `PDF loaded from current Chrome workflow ✅\n${fileName} • ${S.pages} page(s) • ${bytes.length.toLocaleString()} bytes`;
    }
    setBox("engine", `ENGINE PASS ✅\n${fileName} loaded from source website — ${S.pages} page(s).`, "ok");
    log(`Extension source loaded: ${sourceUrl}`);
  } catch (error) {
    if ($("sourceLoadStatus")) {
      $("sourceLoadStatus").className = "status err";
      $("sourceLoadStatus").textContent =
        `Could not load this PDF directly ❌\n${error.message}\n\n` +
        `Use “Open PDF” below as a fallback. For protected/opaque/blob viewers we add a source-specific capture adapter without changing the PDFium engine.`;
    }
    log(`Source load failed: ${error.stack || error.message}`);
  }
}

function extensionSourceParams() {
  const p = new URLSearchParams(location.search);
  return {
    source: p.get("source") || "",
    returnUrl: p.get("return") || "",
  };
}

async function boot() {
  showCapabilities();
  setHealth("ENGINE: STARTING","loading");
  try {
    if (!window.isSecureContext) throw new Error("AttachmentGuard must run over HTTPS (secure context)");
    if (typeof WebAssembly !== "object") throw new Error("WebAssembly is not supported in this browser");

    setBox("engine", `1/4 Loading packaged PDFium WASM\n${PDFIUM_WASM}`);
    const response = await timeout(fetch(PDFIUM_WASM, { cache:"force-cache" }), 20000, "PDFium WASM fetch");
    if (!response.ok) throw new Error(`WASM HTTP ${response.status} ${response.statusText}`);
    const wasmBinary = await timeout(response.arrayBuffer(), 15000, "PDFium WASM read");
    if (!validWasmHeader(wasmBinary)) {
      throw new Error(`Received ${wasmBinary.byteLength} bytes, but /assets/pdfium.wasm is not a valid WebAssembly file`);
    }
    log(`Self-hosted WASM loaded: ${wasmBinary.byteLength.toLocaleString()} bytes`);

    setBox("engine","2/4 Initializing PDFium WebAssembly…");
    S.m = await timeout(init({ wasmBinary }), 25000, "PDFium initialization");

    setBox("engine","3/4 Initializing PDFium extension layer…");
    S.m.PDFiumExt_Init();

    setBox("engine","4/4 Running real PDFium engine self-test…");
    await engineSelfTest();

    S.engineReady = true;
    setHealth("ENGINE: PASS ✅","ok");
    setBox("engine","PDFium ENGINE PASS ✅\nSelf-hosted WASM loaded, PDFium initialized, and a real in-memory PDF/page self-test succeeded.","ok");
    $("openPdfLabel").style.opacity = "1";
    $("openPdfLabel").style.pointerEvents = "auto";
    log("PDFium engine health PASS");
    const mimeCapture = await mimeCapturePromise;
    if (mimeCapture?.info) {
      await loadMimeHandlerPdf(mimeCapture);
    } else {
      const sourceParams = extensionSourceParams();
      if (sourceParams.source) {
        await loadExtensionSourcePdf(sourceParams.source);
      } else if ($("sourceContext")) {
        $("sourceContext").classList.add("hidden");
      }
    }

  } catch (e) {
    S.engineReady = false;
    log(e.stack || e.message);
    const mimeCapture = await mimeCapturePromise.catch(() => null);
    if (mimeCapture?.info && chrome.mimeHandler?.abortAndFallbackToNativeHandler) {
      try {
        await chrome.mimeHandler.abortAndFallbackToNativeHandler();
        return;
      } catch (fallbackError) {
        log(`Native PDF fallback failed: ${fallbackError.message}`);
      }
    }
    setHealth("ENGINE: FAILED ❌","err");
    setBox("engine",`PDFium ENGINE FAILED ❌\n${e.message}\n\nOpen Technical diagnostics for details.`,"err");
  }
}
$("selfTestBtn").onclick = async () => {
  try {
    setBox("engine","Running manual PDFium self-test…");
    await engineSelfTest();
    setHealth("ENGINE: PASS ✅","ok");
    setBox("engine","Manual PDFium self-test PASS ✅","ok");
    log("Manual engine self-test PASS");
  } catch (e) {
    setHealth("ENGINE: FAILED ❌","err");
    setBox("engine",`Manual self-test FAILED ❌\n${e.message}`,"err");
    log(e.stack || e.message);
  }
};
boot();

function closeDoc() {
  if (!S.m) return;
  const r = rt();
  try { if (S.doc) S.m.FPDF_CloseDocument(S.doc); } catch {}
  try { if (S.ptr) r.free(S.ptr); } catch {}
  S.doc = 0; S.ptr = 0;
}
function openBytes(bytes) {
  closeDoc();
  const r = rt(), p = r.malloc(bytes.length);
  r.heap().set(bytes,p);
  const d = S.m.FPDF_LoadMemDocument(p,bytes.length,0);
  if (!d) {
    r.free(p);
    throw Error(`PDFium could not open PDF. Error ${S.m.FPDF_GetLastError()}`);
  }
  S.bytes = bytes; S.ptr = p; S.doc = d; S.pages = S.m.FPDF_GetPageCount(d);
}
function cstr(fn,h) {
  if (!h) return "";
  const n = fn(h,0,0);
  if (!n) return "";
  const r = rt(), p = r.malloc(n);
  try { fn(h,p,n); return r.u8(p); } finally { r.free(p); }
}
function readMatrix(o) {
  const r=rt(), p=r.malloc(24);
  try {
    if (!S.m.FPDFPageObj_GetMatrix(o,p)) return [1,0,0,1,0,0];
    return [0,4,8,12,16,20].map(k=>r.gf(p+k));
  } finally { r.free(p); }
}
function writeMatrix(o,m) {
  const r=rt(), p=r.malloc(24);
  try {
    m.forEach((v,i)=>r.sf(p+i*4,v));
    if (!S.m.FPDFPageObj_SetMatrix(o,p)) throw Error("Could not preserve transform matrix");
  } finally { r.free(p); }
}
function readRGBA(fn,o,def=[0,0,0,255]) {
  const r=rt(), p=r.malloc(16);
  try { return fn(o,p,p+4,p+8,p+12) ? [0,4,8,12].map(x=>r.gi(p+x)) : def; }
  finally { r.free(p); }
}
function readFloatProp(fn,o,def=0) {
  const r=rt(), p=r.malloc(4);
  try { return fn(o,p) ? r.gf(p) : def; } finally { r.free(p); }
}
function readBounds(o) {
  const r=rt(), p=r.malloc(16);
  try {
    if (!S.m.FPDFPageObj_GetBounds(o,p,p+4,p+8,p+12)) return null;
    return {left:r.gf(p),bottom:r.gf(p+4),right:r.gf(p+8),top:r.gf(p+12)};
  } finally { r.free(p); }
}
function readText(o,tp) {
  const units = S.m.FPDFTextObj_GetText(o,tp,0,0);
  if (units <= 0) return "";
  const r=rt(), p=r.malloc(units*2);
  try {
    S.m.FPDFTextObj_GetText(o,tp,p,units);
    return r.u16(p).replace(/\0/g,"");
  } finally { r.free(p); }
}

/* WebAssembly is wasm32 here, so size_t is 32-bit. */
function fontData(font) {
  if (!font) return null;
  const r=rt(), outLen=r.malloc(4);
  try {
    if (!S.m.FPDFFont_GetFontData(font,0,0,outLen)) return null;
    const size = r.gi(outLen) >>> 0;
    if (!size || size > 100_000_000) return null;
    const p=r.malloc(size);
    try {
      if (!S.m.FPDFFont_GetFontData(font,p,size,outLen)) return null;
      const actual = r.gi(outLen) >>> 0;
      if (!actual || actual > size) return null;
      return r.heap().slice(p,p+actual);
    } finally { r.free(p); }
  } catch (e) {
    log(`FPDFFont_GetFontData failed: ${e.message}`);
    return null;
  } finally { r.free(outLen); }
}
function parseFont(bytes) {
  if (!bytes || bytes.length < 4) return {ok:false,error:"No parseable font data"};
  try {
    const ab = bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength);
    return {ok:true,font:opentype.parse(ab),bytes};
  } catch (e) {
    return {ok:false,error:`Font data could not be parsed as TTF/OTF: ${e.message}`};
  }
}
function glyphMissing(parsed,text) {
  if (!parsed?.ok) return [];
  const miss=[];
  for (const ch of codepoints(text)) {
    if (/\s/.test(ch)) continue;
    if (!parsed.font.charToGlyphIndex(ch)) miss.push(ch);
  }
  return [...new Set(miss)];
}
function fsTypeInfo(parsed) {
  const fs = parsed?.ok ? Number(parsed.font?.tables?.os2?.fsType ?? 0) : null;
  if (fs === null) return {allowed:false,text:"Unknown embedding rights"};
  const usage=fs&0x000F, noSubset=!!(fs&0x0100), bitmapOnly=!!(fs&0x0200);
  let allowed=false, reason="";
  if (bitmapOnly) reason="Bitmap-only embedding is not valid for editable text.";
  else if (usage===0) { allowed=true; reason="Installable embedding allowed."; }
  else if (usage&0x0008) { allowed=true; reason="Editable embedding allowed."; }
  else if (usage&0x0004) reason="Preview & Print embedding only; editable re-embedding blocked.";
  else if (usage&0x0002) reason="Restricted License embedding; re-embedding blocked.";
  else reason="Unknown/restricted embedding permission.";
  if (noSubset) { allowed=false; reason += " Font sets No Subsetting."; }
  return {allowed,fsType:fs,text:reason};
}
function readStyle(o) {
  const font=S.m.FPDFTextObj_GetFont(o), mat=readMatrix(o), size=readFloatProp(S.m.FPDFTextObj_GetFontSize,o,0);
  let angle=0;
  try {
    const r=rt(), p=r.malloc(4);
    try { if (font && S.m.FPDFFont_GetItalicAngle(font,p)) angle=r.gi(p); } finally { r.free(p); }
  } catch {}
  return {
    fontName:cstr(S.m.FPDFFont_GetBaseFontName,font),
    family:cstr(S.m.FPDFFont_GetFamilyName,font),
    size, weight:font?S.m.FPDFFont_GetWeight(font):-1, italic:angle,
    embedded:font?S.m.FPDFFont_GetIsEmbedded(font):-1, font,
    fill:readRGBA(S.m.FPDFPageObj_GetFillColor,o),
    stroke:readRGBA(S.m.FPDFPageObj_GetStrokeColor,o),
    strokeWidth:readFloatProp(S.m.FPDFPageObj_GetStrokeWidth,o,0),
    matrix:mat, render:S.m.FPDFTextObj_GetTextRenderMode(o),
    transparency:!!S.m.FPDFPageObj_HasTransparency(o)
  };
}
function styleIdentity(s) {
  const base=stripSubset(s.fontName), nm=(base+" "+(s.family||"")).toLowerCase();
  return {
    base, family:stripSubset(s.family), weight:s.weight, italic:s.italic,
    bold:/bold|black|heavy|semibold|demibold/.test(nm),
    slanted:s.italic!==0 || /italic|oblique/.test(nm)
  };
}
function sameIdentity(a,b) {
  const aa=styleIdentity(a), bb=styleIdentity(b);
  if (norm(aa.base)===norm(bb.base)) return true;
  return norm(aa.family)===norm(bb.family) && aa.bold===bb.bold && aa.slanted===bb.slanted;
}
function listObjects(doc,pageIndex) {
  const page=S.m.FPDF_LoadPage(doc,pageIndex);
  if (!page) return [];
  const tp=S.m.FPDFText_LoadPage(page), out=[], count=S.m.FPDFPage_CountObjects(page);
  try {
    for (let i=0;i<count;i++) {
      const o=S.m.FPDFPage_GetObject(page,i);
      if (S.m.FPDFPageObj_GetType(o)!==TEXT) continue;
      const b=readBounds(o); if (!b) continue;
      const t=readText(o,tp); if (!t.trim()) continue;
      out.push({index:i,text:t,bounds:b,style:readStyle(o)});
    }
    return out;
  } finally {
    S.m.FPDFText_ClosePage(tp); S.m.FPDF_ClosePage(page);
  }
}
function overlapArea(a,b) {
  const l=Math.max(a.left,b.left), r=Math.min(a.right,b.right), bo=Math.max(a.bottom,b.bottom), t=Math.min(a.top,b.top);
  return Math.max(0,r-l)*Math.max(0,t-bo);
}
function objArea(a) { return Math.max(0,a.right-a.left)*Math.max(0,a.top-a.bottom); }
function newCollision(beforeBounds,afterBounds,others) {
  for (const o of others) {
    const before=overlapArea(beforeBounds,o.bounds), after=overlapArea(afterBounds,o.bounds);
    const material=after>Math.max(1,Math.min(objArea(afterBounds),objArea(o.bounds))*.05);
    if (material && after>before+0.75) return o;
  }
  return null;
}

async function render() {
  const p=S.m.FPDF_LoadPage(S.doc,S.page);
  if (!p) throw Error("Cannot load page");
  try {
    const rot=S.m.FPDFPage_GetRotation(p);
    S.pw=S.m.FPDF_GetPageWidthF(p); S.ph=S.m.FPDF_GetPageHeightF(p);
    const avail=Math.max(320,document.querySelector(".viewer").clientWidth-20);
    const fit=Math.min(1.35,avail/S.pw); S.scale=fit*S.zoom;
    const dpr=Math.min(devicePixelRatio||1,2), w=Math.max(1,Math.floor(S.pw*S.scale*dpr)), h=Math.max(1,Math.floor(S.ph*S.scale*dpr));
    const r=rt(), buf=r.malloc(w*h*4), bm=S.m.FPDFBitmap_CreateEx(w,h,4,buf,w*4);
    if (!bm) { r.free(buf); throw Error("FPDFBitmap_CreateEx failed"); }
    S.m.FPDFBitmap_FillRect(bm,0,0,w,h,0xffffffff);
    S.m.FPDF_RenderPageBitmap(bm,p,0,0,w,h,0,16);
    const data=r.heap().slice(buf,buf+w*h*4), c=$("canvas");
    c.width=w;c.height=h;c.style.width=`${w/dpr}px`;c.style.height=`${h/dpr}px`;
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(data.buffer),w,h),0,0);
    S.m.FPDFBitmap_Destroy(bm); r.free(buf);
    $("stage").style.width=`${S.pw*S.scale}px`; $("stage").style.height=`${S.ph*S.scale}px`;
    S.objs=rot===0?listObjects(S.doc,S.page):[];
    draw();
    $("pageInfo").textContent=`${S.page+1} / ${S.pages}`; $("zoomInfo").textContent=`${Math.round(S.zoom*100)}%`;
    $("prev").disabled=S.page===0; $("next").disabled=S.page===S.pages-1;
    setBox("pageStatus",rot!==0?"Rotated pages are blocked in this strict build.":`${S.objs.length} real PDF text objects found. Click text to edit.`,rot?"warn":"ok");
  } finally { S.m.FPDF_ClosePage(p); }
}
function draw() {
  const ov=$("overlay"); ov.innerHTML="";
  for (const o of S.objs) {
    const b=o.bounds, e=document.createElement("button");
    e.className="hit"; e.setAttribute("aria-label",`Edit ${o.text}`);
    e.style.left=`${b.left*S.scale}px`; e.style.top=`${(S.ph-b.top)*S.scale}px`;
    e.style.width=`${Math.max(7,(b.right-b.left)*S.scale)}px`; e.style.height=`${Math.max(8,(b.top-b.bottom)*S.scale)}px`;
    e.dataset.objIndex=String(o.index);
    if (S.searchMatches.some(m=>m.page===S.page && m.index===o.index)) e.classList.add("searchMatch");
    const current=S.searchMatches[S.searchCursor];
    if (current && current.page===S.page && current.index===o.index) e.classList.add("searchCurrent");
    e.onclick=()=>selectObj(o,e); ov.appendChild(e);
  }
}
function fontFingerprint(font) {
  const bytes=fontData(font);
  if (!bytes) return "no-font-data";
  let h=2166136261;
  const step=Math.max(1,Math.floor(bytes.length/8192));
  for (let i=0;i<bytes.length;i+=step) { h^=bytes[i]; h=Math.imul(h,16777619); }
  return `${(h>>>0).toString(16)}-${bytes.length}`;
}
function pdfNativeRepertoire(targetStyle) {
  const targetKey=fontFingerprint(targetStyle.font), chars=new Map(), fontKeyCache=new Map();
  for (let pageIndex=0;pageIndex<S.pages;pageIndex++) {
    const page=S.m.FPDF_LoadPage(S.doc,pageIndex);
    if (!page) continue;
    const tp=S.m.FPDFText_LoadPage(page);
    try {
      const count=S.m.FPDFText_CountChars(tp);
      for (let i=0;i<count;i++) {
        const obj=S.m.FPDFText_GetTextObject(tp,i);
        if (!obj || S.m.FPDFPageObj_GetType(obj)!==TEXT) continue;
        const font=S.m.FPDFTextObj_GetFont(obj);
        let key=fontKeyCache.get(font);
        if (!key) { key=fontFingerprint(font); fontKeyCache.set(font,key); }
        if (key!==targetKey) continue;
        const cp=S.m.FPDFText_GetUnicode(tp,i);
        const mapError=typeof S.m.FPDFText_HasUnicodeMapError==="function" ? S.m.FPDFText_HasUnicodeMapError(tp,i) : 0;
        if (cp && mapError===0) {
          const ch=String.fromCodePoint(cp);
          if (!/\s/.test(ch)) chars.set(ch,(chars.get(ch)||0)+1);
        }
      }
    } finally { S.m.FPDFText_ClosePage(tp); S.m.FPDF_ClosePage(page); }
  }
  return {key:targetKey, chars};
}
function embeddedPreflight(o,text) {
  const data=fontData(o.style.font), parsed=parseFont(data), repertoire=pdfNativeRepertoire(o.style);
  const required=[...new Set(Array.from(text).filter(ch=>!/\s/.test(ch)))];
  const coverage=required.map(ch=>{
    if (repertoire.chars.has(ch)) return {ch,source:"PDF-native mapping"};
    if (parsed.ok && !glyphMissing(parsed,ch).length) return {ch,source:"embedded font cmap"};
    return {ch,source:"unresolved"};
  });
  const missing=coverage.filter(x=>x.source==="unresolved").map(x=>x.ch);
  return {data,parsed,repertoire,coverage,missing,subset:subsetRx.test(o.style.fontName)};
}
function renderMeta(o,pf) {
  const subset=subsetRx.test(o.style.fontName);
  $("chips").innerHTML = [
    ["Font",o.style.embedded===1?(subset?"Embedded subset":"Embedded"):"Not embedded",o.style.embedded===1?"good":"warn"],
    ["Glyph coverage",pf.missing.length?`Needs exact font for ${pf.missing.map(cpLabel).join(", ")}`:`${pf.coverage.length}/${pf.coverage.length} proven safe`,pf.missing.length?"bad":"good"],
    ["Exactness","No substitution","good"]
  ].map(([a,b,k])=>`<span class="chip ${k}">${a}: ${b}</span>`).join("");
  const rows=[
    ["Font",o.style.fontName],["Family",o.style.family||"—"],["Size",`${o.style.size.toFixed(2)} pt`],["Weight",String(o.style.weight)],
    ["Italic angle",`${o.style.italic}°`],["Embedded",o.style.embedded===1?"Yes":"No"],["Transparency",o.style.transparency?"Yes":"No"],["Render mode",String(o.style.render)]
  ];
  $("metaGrid").innerHTML=rows.map(([a,b])=>`<div class="meta"><span>${a}</span><b>${b}</b></div>`).join("");
}
function selectObj(o,e) {
  document.querySelectorAll(".hit.sel").forEach(x=>x.classList.remove("sel")); e.classList.add("sel");
  S.sel=o;S.uploadedFont=null;S.resolvedFont=null;
  $("origText").textContent=o.text; $("replacement").value=o.text;
  $("resolverWrap").classList.add("hidden"); $("localFontStatus").textContent=""; $("fontUploadStatus").textContent="";
  $("verdict").classList.add("hidden"); $("checks").innerHTML="";
  const pf=embeddedPreflight(o,o.text); S.preflight=pf; renderMeta(o,pf);
  $("preflight").textContent=o.style.embedded!==1
    ?"Original font is not embedded. Strict mode requires the exact font before editing."
    :pf.missing.length
      ?`PDF-native + embedded-font check needs exact-font resolution for: ${pf.missing.map(cpLabel).join(", ")}.`
      :`Character coverage verified. ${pf.coverage.filter(x=>x.source==="PDF-native mapping").length} character(s) were proven from the PDF's own Unicode mapping; the remainder were proven from the embedded font cmap.`;
  $("panel").classList.add("open");
}
function refreshSelectedPreflight() {
  if (!S.sel) return;
  const pf=embeddedPreflight(S.sel,$("replacement").value); S.preflight=pf; renderMeta(S.sel,pf);
  $("preflight").textContent=pf.missing.length
    ?`Unresolved only: ${pf.missing.map(cpLabel).join(", ")}. Characters already used by this exact PDF font are treated as safe even when the raw subset cmap is incomplete.`
    :`All replacement characters are proven safe by PDF-native mappings and/or the embedded font cmap.`;
  if (S.sel.style.embedded!==1 || !pf.parsed.ok || pf.missing.length) $("resolverWrap").classList.remove("hidden");
  else $("resolverWrap").classList.add("hidden");
}
$("replacement").addEventListener("input",()=>{S.resolvedFont=null;refreshSelectedPreflight();});
function fontMatchUploaded(parsed,orig) {
  if (!parsed.ok) return false;
  const ps=parsed.font.names?.postScriptName?.en||"", fam=parsed.font.names?.fontFamily?.en||"", sub=parsed.font.names?.fontSubfamily?.en||"";
  const target=styleIdentity(orig), cand=(ps+" "+fam+" "+sub).toLowerCase();
  const bold=/bold|black|heavy|semibold|demibold/.test(cand), slanted=/italic|oblique/.test(cand);
  const nameMatch=norm(ps)===norm(target.base)||norm(fam)===norm(target.family)||norm(fam)===norm(target.base);
  return nameMatch && bold===target.bold && slanted===target.slanted;
}
function fontVaultId(bytes) {
  let h=2166136261; const step=Math.max(1,Math.floor(bytes.length/4096));
  for (let i=0;i<bytes.length;i+=step) { h^=bytes[i]; h=Math.imul(h,16777619); }
  return `font-${(h>>>0).toString(16)}-${bytes.length}`;
}
function validateFontBytes(bytes,origStyle,newText,source) {
  const parsed=parseFont(bytes);
  if (!parsed.ok) return {ok:false,reason:parsed.error};
  if (!fontMatchUploaded(parsed,origStyle)) return {ok:false,reason:`${source} font does not exactly match ${stripSubset(origStyle.fontName)}`};
  const missing=glyphMissing(parsed,newText);
  if (missing.length) return {ok:false,reason:`Font is missing ${missing.map(cpLabel).join(", ")}`};
  const rights=fsTypeInfo(parsed);
  if (!rights.allowed) return {ok:false,reason:`Embedding permission blocks this edit: ${rights.text}`};
  const names={family:parsed.font.names?.fontFamily?.en||"",postscript:parsed.font.names?.postScriptName?.en||"",subfamily:parsed.font.names?.fontSubfamily?.en||""};
  return {ok:true,source,bytes,parsed,rights,label:source,id:fontVaultId(bytes),names};
}
async function rememberResolvedFont(v) {
  if (!v?.ok || !$("rememberFont")?.checked) return;
  await vaultPut({id:v.id,names:v.names,source:v.source,savedAt:Date.now(),bytes:v.bytes.buffer.slice(v.bytes.byteOffset,v.bytes.byteOffset+v.bytes.byteLength)});
  await refreshVaultCount();
}
async function findExactFontInVault(origStyle,newText) {
  try {
    const entries=await vaultList();
    for (const e of entries) {
      const v=validateFontBytes(new Uint8Array(e.bytes),origStyle,newText,"Font Vault");
      if (v.ok) return v;
    }
  } catch (e) { log(`Font Vault lookup failed: ${e.message}`); }
  return null;
}
async function resolveLocalFont() {
  if (!S.sel) return;
  const newText=$("replacement").value;
  if (!("queryLocalFonts" in window)) {
    $("localFontStatus").textContent="Local Font Access is not supported here. Upload the exact font instead.";
    return;
  }
  $("localFontStatus").textContent="Chrome may ask permission to access installed fonts…";
  try {
    const target=stripSubset(S.sel.style.fontName), targetStyle=styleIdentity(S.sel.style);
    let fonts=await window.queryLocalFonts({postscriptNames:[target]});
    if (!fonts.length) fonts=await window.queryLocalFonts();
    for (const fd of fonts) {
      const nm=(fd.postscriptName+" "+fd.family+" "+fd.style).toLowerCase();
      const bold=/bold|black|heavy|semibold|demibold/.test(nm), slanted=/italic|oblique/.test(nm);
      if (!((norm(fd.postscriptName)===norm(target)||norm(fd.family)===norm(stripSubset(S.sel.style.family))||norm(fd.family)===norm(target)) && bold===targetStyle.bold && slanted===targetStyle.slanted)) continue;
      const bytes=new Uint8Array(await (await fd.blob()).arrayBuffer());
      const v=validateFontBytes(bytes,S.sel.style,newText,"installed");
      if (v.ok) {
        S.resolvedFont=v;
        $("localFontStatus").textContent=`Exact installed font resolved ✅ ${fd.fullName||fd.postscriptName}. ${v.rights.text}`;
        await rememberResolvedFont(v);
        return;
      }
    }
    $("localFontStatus").textContent="No exact installed font with the required characters was found.";
  } catch (e) {
    $("localFontStatus").textContent=`Local font access failed/was denied: ${e.message}`;
  }
}
$("resolveLocalBtn").onclick=resolveLocalFont;

$("fontFile").onchange=async e=>{
  if (!S.sel) return;
  const f=e.target.files?.[0]; if (!f) return;
  const bytes=new Uint8Array(await f.arrayBuffer());
  const v=validateFontBytes(bytes,S.sel.style,$("replacement").value,"uploaded");
  if (v.ok) { S.uploadedFont=v; S.resolvedFont=v; $("fontUploadStatus").textContent=`Exact font accepted ✅ ${f.name}. ${v.rights.text}`; await rememberResolvedFont(v); }
  else { S.uploadedFont=null; $("fontUploadStatus").textContent=`Font rejected ❌ ${v.reason}`; }
};

function findExactFontInPdf(origStyle,newText) {
  for (let pi=0;pi<S.pages;pi++) {
    for (const cand of listObjects(S.doc,pi)) {
      if (cand.style.embedded!==1 || !sameIdentity(origStyle,cand.style)) continue;
      const bytes=fontData(cand.style.font), parsed=parseFont(bytes);
      if (!parsed.ok || glyphMissing(parsed,newText).length) continue;
      const rights=fsTypeInfo(parsed);
      if (!rights.allowed) continue;
      return {ok:true,source:"same PDF",bytes,parsed,rights,label:"same PDF"};
    }
  }
  return null;
}
async function autoResolveFont(origStyle,newText) {
  let found=findExactFontInPdf(origStyle,newText);
  if (found) return found;
  found=await findExactFontInVault(origStyle,newText);
  return found;
}
$("resolveAutoBtn")?.addEventListener("click",async()=>{
  if (!S.sel) return;
  $("localFontStatus").textContent="Searching same PDF and local Font Vault…";
  const found=await autoResolveFont(S.sel.style,$("replacement").value);
  if (found) { S.resolvedFont=found; $("localFontStatus").textContent=`Exact font resolved automatically ✅ Source: ${found.source}`; }
  else $("localFontStatus").textContent="No exact font found automatically. Search installed fonts or upload the exact font.";
});
function fontType(bytes) {
  if (bytes.length<4) return FONT_TRUETYPE;
  const s=String.fromCharCode(...bytes.slice(0,4));
  return (s==="OTTO"||s==="typ1")?FONT_TYPE1:FONT_TRUETYPE;
}
function setText(o,text) {
  const r=rt(), n=(text.length+1)*2, p=r.malloc(n);
  try { r.w16(text,p,n); if (!S.m.FPDFText_SetText(o,p)) throw Error("FPDFText_SetText failed"); }
  finally { r.free(p); }
}
function copyGraphics(src,dst) {
  const s=readStyle(src);
  if (s.transparency) throw Error("Strict rebuild blocked: this text object uses transparency.");
  writeMatrix(dst,s.matrix);
  if (!S.m.FPDFPageObj_SetFillColor(dst,...s.fill)) throw Error("Could not preserve fill color");
  if (!S.m.FPDFPageObj_SetStrokeColor(dst,...s.stroke)) throw Error("Could not preserve stroke color");
  if (!S.m.FPDFPageObj_SetStrokeWidth(dst,s.strokeWidth)) throw Error("Could not preserve stroke width");
  if (!S.m.FPDFTextObj_SetTextRenderMode(dst,s.render)) throw Error("Could not preserve text render mode");
  return s;
}
function rebuildWithFont(doc,page,obj,fontBytes,newText) {
  const r=rt(), p=r.malloc(fontBytes.length); r.heap().set(fontBytes,p);
  let font=0,newObj=0,inserted=false;
  try {
    font=S.m.FPDFText_LoadFont(doc,p,fontBytes.length,fontType(fontBytes),1);
    if (!font) throw Error("PDFium could not load the exact full font");
    const old=readStyle(obj);
    newObj=S.m.FPDFPageObj_CreateTextObj(doc,font,old.size);
    if (!newObj) throw Error("Could not create replacement text object");
    setText(newObj,newText); copyGraphics(obj,newObj);
    S.m.FPDFPage_InsertObject(page,newObj); inserted=true;
    if (!S.m.FPDFPage_RemoveObject(page,obj)) throw Error("Could not remove original text object");
    S.m.FPDFPageObj_Destroy(obj);
    return {obj:newObj,font};
  } catch (e) {
    if (newObj&&!inserted) S.m.FPDFPageObj_Destroy(newObj);
    if (font) S.m.FPDFFont_Close(font);
    throw e;
  } finally { r.free(p); }
}
function saveDoc(doc) {
  const r=rt(), w=S.m.PDFiumExt_OpenFileWriter();
  if (!w) throw Error("Could not create PDF writer");
  try {
    if (!S.m.PDFiumExt_SaveAsCopy(doc,w)) throw Error("PDF save failed");
    const n=S.m.PDFiumExt_GetFileWriterSize(w);
    if (!n) throw Error("Saved PDF is empty");
    const p=r.malloc(n);
    try { S.m.PDFiumExt_GetFileWriterData(w,p,n); return r.heap().slice(p,p+n); }
    finally { r.free(p); }
  } finally { S.m.PDFiumExt_CloseFileWriter(w); }
}
function tempOpen(bytes) {
  const r=rt(), p=r.malloc(bytes.length); r.heap().set(bytes,p);
  const d=S.m.FPDF_LoadMemDocument(p,bytes.length,0);
  if (!d) { r.free(p); throw Error("Working-copy open failed"); }
  return {doc:d,ptr:p,close(){S.m.FPDF_CloseDocument(d);r.free(p);}};
}
function findByTextGeom(doc,pageIndex,text,near) {
  const arr=listObjects(doc,pageIndex).filter(o=>o.text===text);
  arr.sort((a,b)=>overlapArea(near,b.bounds)-overlapArea(near,a.bounds));
  return arr[0]||null;
}
function unicodeAudit(doc,pageIndex,objIndex) {
  const page=S.m.FPDF_LoadPage(doc,pageIndex);
  if (!page) return {text:"",mapErrors:1,zeroUnicode:1,count:0};
  const target=S.m.FPDFPage_GetObject(page,objIndex),tp=S.m.FPDFText_LoadPage(page);
  let text="",mapErrors=0,zeroUnicode=0,count=0;
  try {
    const n=S.m.FPDFText_CountChars(tp);
    for (let i=0;i<n;i++) {
      if (S.m.FPDFText_GetTextObject(tp,i)!==target) continue;
      const cp=S.m.FPDFText_GetUnicode(tp,i);
      const err=typeof S.m.FPDFText_HasUnicodeMapError==="function" ? S.m.FPDFText_HasUnicodeMapError(tp,i) : 0;
      count++; if (err!==0) mapErrors++; if (!cp) zeroUnicode++; else text+=String.fromCodePoint(cp);
    }
    return {text,mapErrors,zeroUnicode,count};
  } finally { S.m.FPDFText_ClosePage(tp); S.m.FPDF_ClosePage(page); }
}
function compareStyles(a,b,resolved) {
  const checks=[], push=(name,v)=>checks.push([name,!!v]);
  push("Text saved exactly",true);
  push("Font identity preserved",sameIdentity(a,b));
  push("Font size preserved",Math.abs(a.size-b.size)<.03);
  push("Font weight preserved",a.weight<0||b.weight<0||a.weight===b.weight);
  push("Italic metadata preserved",a.italic===b.italic);
  push("Fill color preserved",JSON.stringify(a.fill)===JSON.stringify(b.fill));
  push("Stroke color preserved",JSON.stringify(a.stroke)===JSON.stringify(b.stroke));
  push("Stroke width preserved",Math.abs(a.strokeWidth-b.strokeWidth)<.01);
  push("Text render mode preserved",a.render===b.render);
  push("Transform matrix preserved",a.matrix.every((v,i)=>Math.abs(v-b.matrix[i])<.0005));
  if (resolved) push("Resolved font is embedded",b.embedded===1);
  return checks;
}
function showChecks(checks) {
  $("checks").innerHTML=checks.map(([n,v])=>`<div class="check ${v?"pass":"fail"}">${v?"✅":"❌"} ${n}</div>`).join("");
}


function cloneChanges() {
  return S.changes.map(x => ({...x}));
}
function snapshot() {
  return { bytes:S.bytes.slice(), changes:cloneChanges() };
}
function updateUndoRedo() {
  $("undoBtn").disabled=!S.history.length;
  $("redoBtn").disabled=!S.redo.length;
  $("resetBtn").disabled=!S.originalBytes;
}
function updateSessionUI() {
  const count=S.changes.length;
  $("changesCount").textContent=`${count} verified edit${count===1?"":"s"}`;
  $("correctedName").value=S.name||"";
  $("attachmentStatus").className=`readyBox ${count?"":"neutral"}`;
  $("attachmentStatus").textContent=count
    ? `ATTACHMENT READY ✅\n${count} verified edit${count===1?"":"s"}. Download/export uses the last fully verified PDF only.`
    : `Original attachment loaded. No edits have been accepted yet.`;
  $("changesList").innerHTML=S.changes.length
    ? [...S.changes].reverse().map((c,ri)=>{
        const i=S.changes.length-ri;
        return `<div class="changeItem"><b>${i}. Page ${c.page+1} • ${escapeHtml(c.mode)}</b><span>${escapeHtml(c.oldText)} → ${escapeHtml(c.newText)}</span></div>`;
      }).join("")
    : `<div class="small">No verified edits yet.</div>`;
  updateUndoRedo();
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[ch]));
}
function recordChange({page,oldText,newText,mode}) {
  S.changes.push({ page,oldText,newText,mode,at:Date.now() });
  updateSessionUI();
}
function clearSearch({keepInputs=true}={}) {
  S.searchMatches=[];S.searchCursor=-1;
  $("searchCount").textContent="0 matches";
  $("searchResults").innerHTML="";
  $("searchPrev").disabled=true;$("searchNext").disabled=true;$("replaceAllBtn").disabled=true;
  if(!keepInputs){$("searchInput").value="";$("replaceAllInput").value=""}
}
function runSearch({quiet=false}={}) {
  if(!S.doc)return [];
  const q=$("searchInput").value.trim();
  clearSearch();
  if(!q){$("searchStatus").textContent="Enter text to search.";return []}
  const needle=q.toLocaleLowerCase();
  const matches=[];
  for(let page=0;page<S.pages;page++){
    for(const o of listObjects(S.doc,page)){
      if(o.text.toLocaleLowerCase().includes(needle)){
        matches.push({page,index:o.index,text:o.text,bounds:{...o.bounds},exact:o.text===q});
      }
    }
  }
  S.searchMatches=matches;S.searchCursor=matches.length?0:-1;
  $("searchCount").textContent=`${matches.length} match${matches.length===1?"":"es"}`;
  $("searchPrev").disabled=matches.length<2;$("searchNext").disabled=matches.length<2;
  const exactCount=matches.filter(m=>m.exact).length;
  $("replaceAllBtn").disabled=!exactCount||!$("replaceAllInput").value.length;
  $("searchStatus").textContent=matches.length
    ? `${matches.length} object match${matches.length===1?"":"es"} across ${new Set(matches.map(m=>m.page)).size} page(s). ${exactCount} exact object match${exactCount===1?"":"es"} eligible for Replace All.`
    : `No PDF text objects contain "${q}".`;
  $("searchResults").innerHTML=matches.slice(0,80).map((m,i)=>
    `<button class="resultItem" data-search-index="${i}"><b>Page ${m.page+1}${m.exact?" • exact":""}</b><span>${escapeHtml(m.text)}</span></button>`
  ).join("") + (matches.length>80?`<div class="small">Showing first 80 of ${matches.length} matches.</div>`:"");
  document.querySelectorAll("[data-search-index]").forEach(btn=>{
    btn.onclick=()=>goToSearchMatch(Number(btn.dataset.searchIndex));
  });
  if(!quiet&&matches.length)goToSearchMatch(0);
  return matches;
}
async function goToSearchMatch(index) {
  if(!S.searchMatches.length)return;
  S.searchCursor=(index+S.searchMatches.length)%S.searchMatches.length;
  const m=S.searchMatches[S.searchCursor];
  S.page=m.page;
  await render();
  const current=listObjects(S.doc,S.page)
    .filter(o=>o.text===m.text)
    .sort((a,b)=>overlapArea(m.bounds,b.bounds)-overlapArea(m.bounds,a.bounds))[0];
  if(!current)return;
  const hit=[...document.querySelectorAll(".hit")].find(e=>Number(e.dataset.objIndex)===current.index);
  if(hit)selectObj(current,hit);
}
async function replaceAllExact() {
  const query=$("searchInput").value;
  const replacement=$("replaceAllInput").value;
  if(!query||!replacement||!S.doc)return;
  runSearch({quiet:true});
  const planned=S.searchMatches.filter(m=>m.text===query).map(m=>({...m,bounds:{...m.bounds}}));
  if(!planned.length){$("searchStatus").textContent="No exact object matches to replace.";return}

  const start=snapshot(), startPage=S.page, accepted=[];
  $("replaceAllBtn").disabled=true;
  $("searchStatus").textContent=`Running atomic verified batch: 0 / ${planned.length}…`;
  try{
    for(let i=0;i<planned.length;i++){
      const m=planned[i];
      S.page=m.page;
      const candidates=listObjects(S.doc,m.page).filter(o=>o.text===query)
        .sort((a,b)=>overlapArea(m.bounds,b.bounds)-overlapArea(m.bounds,a.bounds));
      const current=candidates[0];
      if(!current)throw new Error(`Exact match ${i+1} could not be relocated after prior edits.`);
      S.sel=current;
      const result=await editTransaction(replacement);
      openBytes(result.out);
      accepted.push({page:m.page,oldText:query,newText:replacement,mode:`batch • ${result.mode}`});
      $("searchStatus").textContent=`Running atomic verified batch: ${i+1} / ${planned.length}…`;
    }
    S.history.push(start);if(S.history.length>30)S.history.shift();
    S.redo=[];
    accepted.forEach(c=>S.changes.push({...c,at:Date.now()}));
    S.page=startPage;
    if(S.blob)URL.revokeObjectURL(S.blob);
    S.blob=URL.createObjectURL(new Blob([S.bytes],{type:"application/pdf"}));
    $("downloadBtn").classList.remove("hidden");
    await render();updateSessionUI();
    runSearch({quiet:true});
    $("searchStatus").textContent=`BATCH PASS ✅ ${accepted.length} exact match${accepted.length===1?"":"es"} replaced. The batch committed only after every individual edit passed verification.`;
    log(`BATCH PASS | ${query} -> ${replacement} | ${accepted.length} edits`);
  }catch(e){
    openBytes(start.bytes);S.changes=start.changes;S.page=startPage;await render();updateSessionUI();
    runSearch({quiet:true});
    $("searchStatus").textContent=`BATCH ROLLED BACK ❌ ${e.message}`;
    log(`BATCH ROLLBACK | ${e.stack||e.message}`);
  }finally{
    $("replaceAllBtn").disabled=!S.searchMatches.some(m=>m.text===query)||!replacement;
  }
}

async function editTransaction(newText) {
  const selected=S.sel;
  if (!selected) throw Error("No text selected");
  const sourcePf=embeddedPreflight(selected,newText);
  let mode="in-place exact", resolver=null;

  if (selected.style.embedded!==1 || !sourcePf.parsed.ok || sourcePf.missing.length) {
    resolver=findExactFontInPdf(selected.style,newText) || await findExactFontInVault(selected.style,newText) || S.resolvedFont;
    if (!resolver?.ok) {
      $("resolverWrap").classList.remove("hidden");
      const reason=sourcePf.missing.length
        ? `Original embedded font is missing ${sourcePf.missing.map(cpLabel).join(", ")}.`
        : "Original font cannot be safely verified for the replacement.";
      throw Error(`${reason}\nResolve the exact installed font or upload the exact TTF/OTF, then apply again.`);
    }
    mode=`full-font exact rebuild (${resolver.source})`;
  }

  const wk=tempOpen(S.bytes);
  try {
    const page=S.m.FPDF_LoadPage(wk.doc,S.page);
    if (!page) throw Error("Could not load working page");
    let editedObj=null, loadedFontToClose=0, origStyle, origBounds=selected.bounds;
    try {
      const obj=S.m.FPDFPage_GetObject(page,selected.index);
      if (!obj||S.m.FPDFPageObj_GetType(obj)!==TEXT) throw Error("Selected object changed; reselect it");
      origStyle=readStyle(obj);
      const others=listObjects(wk.doc,S.page).filter(o=>o.index!==selected.index);

      if (mode==="in-place exact") { setText(obj,newText); editedObj=obj; }
      else {
        const rebuilt=rebuildWithFont(wk.doc,page,obj,resolver.bytes,newText);
        editedObj=rebuilt.obj; loadedFontToClose=rebuilt.font;
      }
      try {
        if (!S.m.FPDFPage_GenerateContent(page)) throw Error("FPDFPage_GenerateContent failed");
      } finally {
        if (loadedFontToClose) S.m.FPDFFont_Close(loadedFontToClose);
      }
      const afterBounds=readBounds(editedObj);
      if (!afterBounds) throw Error("Could not read edited bounds");
      const collision=newCollision(origBounds,afterBounds,others);
      if (collision) throw Error(`Layout collision blocked: edited text would newly overlap "${collision.text}"`);
    } finally { S.m.FPDF_ClosePage(page); }

    const out=saveDoc(wk.doc);
    const vr=tempOpen(out);
    try {
      const found=findByTextGeom(vr.doc,S.page,newText,origBounds);
      if (!found) throw Error("Saved PDF reopened, but edited text could not be located");
      const audit=unicodeAudit(vr.doc,S.page,found.index);
      const checks=compareStyles(origStyle,found.style,mode!=="in-place exact");
      checks.push(["PDF object text saved exactly",found.text===newText]);
      checks.push(["PDF Unicode map has no errors",audit.mapErrors===0]);
      checks.push(["PDF Unicode map has no zero characters",audit.zeroUnicode===0]);
      checks.push(["PDF-native character sequence matches",audit.text.replace(/\s/g,"")===newText.replace(/\s/g,"")]);
      if (mode==="in-place exact") checks.push(["Exact embedded font program preserved",fontFingerprint(origStyle.font)===fontFingerprint(found.style.font)]);
      const all=checks.every(x=>x[1]);
      if (!all) {
        const err=Object.assign(new Error(`Round-trip verification failed: ${checks.filter(x=>!x[1]).map(x=>x[0]).join(", ")}`),{checks});
        throw err;
      }
      return {out,mode,checks};
    } finally { vr.close(); }
  } finally { wk.close(); }
}

async function apply() {
  if (!S.sel) return;
  const text=$("replacement").value;
  if (!text.length) return;
  $("apply").disabled=true; $("verdict").className="report warn"; $("verdict").textContent="Running strict preflight and transactional verification…"; $("checks").innerHTML="";
  try {
    const oldText=S.sel.text, editPage=S.page, before=snapshot();
    const result=await editTransaction(text);
    S.history.push(before); if (S.history.length>30) S.history.shift();
    S.redo=[];
    openBytes(result.out);
    recordChange({page:editPage,oldText,newText:text,mode:result.mode});
    if (S.blob) URL.revokeObjectURL(S.blob);
    S.blob=URL.createObjectURL(new Blob([result.out],{type:"application/pdf"}));
    $("downloadBtn").classList.remove("hidden"); $("undoBtn").disabled=false;
    $("verdict").className="report ok";
    $("verdict").textContent=`PASS ✅\nMode: ${result.mode}\nSaved PDF reopened; PDF-native Unicode, exact font/style, and layout verification passed.`;
    showChecks(result.checks); log(`PASS | ${S.sel.text} -> ${text} | ${result.mode}`);
    await render(); updateSessionUI(); if($("searchInput").value.trim())runSearch({quiet:true}); $("panel").classList.remove("open");
  } catch (e) {
    $("verdict").className="report err"; $("verdict").textContent=`BLOCKED / FAIL ❌\n${e.message}`;
    if (e.checks) showChecks(e.checks);
    log(e.stack||e.message);
  } finally { $("apply").disabled=false; }
}
$("apply").onclick=apply;

$("pdfFile").onchange=async e=>{
  if (!S.engineReady) return;
  const f=e.target.files?.[0]; if (!f) return;
  try {
    const b=new Uint8Array(await f.arrayBuffer());
    S.history=[];S.redo=[];S.changes=[];S.originalBytes=b.slice();S.originalName=f.name;
    S.name=f.name.replace(/\.pdf$/i,"")+"-AttachmentGuard.pdf";
    openBytes(b);S.page=0;S.zoom=1;clearSearch({keepInputs:false});
    $("docCard").classList.remove("hidden");$("workTools").classList.remove("hidden");
    updateSessionUI();
    setBox("engine",`ENGINE PASS ✅\n${f.name} loaded — ${S.pages} page(s).`,"ok");
    await render();
    log(`Loaded PDF: ${f.name} (${b.length.toLocaleString()} bytes)`);
  } catch (e2) {
    setBox("engine",`PDF LOAD FAILED ❌\n${e2.message}`,"err");
    log(e2.stack||e2.message);
  }
};
$("undoBtn").onclick=async()=>{
  if(!S.history.length)return;
  S.redo.push(snapshot());
  const prev=S.history.pop();
  openBytes(prev.bytes);S.changes=prev.changes;
  if(S.blob)URL.revokeObjectURL(S.blob);
  S.blob=URL.createObjectURL(new Blob([S.bytes],{type:"application/pdf"}));
  $("downloadBtn").classList.toggle("hidden",!S.changes.length);
  await render();updateSessionUI();if($("searchInput").value.trim())runSearch({quiet:true});log("Undo");
};
$("redoBtn").onclick=async()=>{
  if(!S.redo.length)return;
  S.history.push(snapshot());
  const next=S.redo.pop();
  openBytes(next.bytes);S.changes=next.changes;
  if(S.blob)URL.revokeObjectURL(S.blob);
  S.blob=URL.createObjectURL(new Blob([S.bytes],{type:"application/pdf"}));
  $("downloadBtn").classList.toggle("hidden",!S.changes.length);
  await render();updateSessionUI();if($("searchInput").value.trim())runSearch({quiet:true});log("Redo");
};
$("resetBtn").onclick=async()=>{
  if(!S.originalBytes)return;
  if(!confirm("Reset this attachment to the original PDF and discard all verified edits in this session?"))return;
  openBytes(S.originalBytes.slice());S.history=[];S.redo=[];S.changes=[];S.page=0;
  if(S.blob){URL.revokeObjectURL(S.blob);S.blob=null}
  $("downloadBtn").classList.add("hidden");clearSearch({keepInputs:false});
  await render();updateSessionUI();log("Reset to original attachment");
};
$("downloadBtn").onclick=async()=>{
  if(!S.bytes)return;
  await attachmentBridge.deliver({bytes:S.bytes,fileName:S.name});
  log(`Attachment handoff: browser download • ${S.name}`);
};
$("copyNameBtn").onclick=async()=>{
  try{await navigator.clipboard.writeText(S.name);$("copyNameBtn").textContent="Copied";setTimeout(()=>$("copyNameBtn").textContent="Copy",1200)}
  catch{$("correctedName").select()}
};
$("searchBtn").onclick=()=>runSearch();
$("searchInput").addEventListener("keydown",e=>{if(e.key==="Enter")runSearch()});
$("searchPrev").onclick=()=>goToSearchMatch(S.searchCursor-1);
$("searchNext").onclick=()=>goToSearchMatch(S.searchCursor+1);
$("replaceAllInput").addEventListener("input",()=>{$("replaceAllBtn").disabled=!S.searchMatches.some(m=>m.text===$("searchInput").value)||!$("replaceAllInput").value.length});
$("replaceAllBtn").onclick=replaceAllExact;

if ($("returnToSourceBtn")) {
  $("returnToSourceBtn").onclick = () => {
    const { returnUrl } = extensionSourceParams();
    if (returnUrl) location.href = returnUrl;
    else history.back();
  };
}

$("closePanel").onclick=()=>$("panel").classList.remove("open");
$("prev").onclick=async()=>{if(S.page>0){S.page--;await render();}};
$("next").onclick=async()=>{if(S.page<S.pages-1){S.page++;await render();}};
$("zout").onclick=async()=>{S.zoom=Math.max(.6,S.zoom-.15);await render();};
$("zin").onclick=async()=>{S.zoom=Math.min(2.4,S.zoom+.15);await render();};
