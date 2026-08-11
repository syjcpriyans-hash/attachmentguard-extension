const $ = (id) => document.getElementById(id);
let currentTab = null;
let detected = [];

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function looksPdf(url) {
  try {
    const u = new URL(url);
    const all = `${u.pathname}${u.search}`.toLowerCase();
    return all.includes(".pdf") || u.protocol === "blob:";
  } catch { return false; }
}

function labelFor(url, kind) {
  try {
    const u = new URL(url);
    const name = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || "PDF document");
    return `${kind}: ${name}`;
  } catch {
    return `${kind}: PDF document`;
  }
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function scanPage(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      func: () => {
        const found = [];
        const add = (url, kind) => {
          if (!url || typeof url !== "string") return;
          try {
            const absolute = new URL(url, location.href).href;
            found.push({ url: absolute, kind });
          } catch {}
        };

        document.querySelectorAll("embed").forEach(el => add(el.src, "embed"));
        document.querySelectorAll("object").forEach(el => add(el.data, "object"));
        document.querySelectorAll("iframe").forEach(el => {
          const src = el.src || "";
          if (/\.pdf(?:$|[?#])/i.test(src) || src.startsWith("blob:")) add(src, "iframe");
        });
        document.querySelectorAll('a[href]').forEach(el => {
          const href = el.href || "";
          if (/\.pdf(?:$|[?#])/i.test(href)) add(href, "link");
        });

        try {
          performance.getEntriesByType("resource").forEach(entry => {
            const name = entry.name || "";
            if (/\.pdf(?:$|[?#])/i.test(name)) add(name, "network");
          });
        } catch {}

        const seen = new Set();
        return found.filter(x => {
          if (seen.has(x.url)) return false;
          seen.add(x.url);
          return true;
        }).slice(0, 25);
      },
    });
    return result || [];
  } catch (error) {
    // Chrome's built-in PDF viewer and chrome:// pages may not allow injection.
    return [];
  }
}

function originPattern(url) {
  const u = new URL(url);
  if (u.protocol === "http:" || u.protocol === "https:") return `${u.origin}/*`;
  if (u.protocol === "file:") return "file:///*";
  return null;
}

async function ensureHostAccess(url) {
  const pattern = originPattern(url);
  if (!pattern) return { ok: url.startsWith("blob:"), pattern: null };

  const already = await chrome.permissions.contains({ origins: [pattern] });
  if (already) return { ok: true, pattern };

  try {
    const granted = await chrome.permissions.request({ origins: [pattern] });
    return { ok: granted, pattern };
  } catch (error) {
    return { ok: false, pattern, error };
  }
}

async function openEditor(sourceUrl = "") {
  if (!currentTab) currentTab = await activeTab();
  const returnUrl = currentTab?.url || "";
  const params = new URLSearchParams();
  if (sourceUrl) params.set("source", sourceUrl);
  if (returnUrl) params.set("return", returnUrl);

  if (sourceUrl && sourceUrl.startsWith("blob:")) {
    $("message").className = "card status warn";
    $("message").textContent = "This page uses a blob: PDF. The universal blob-capture adapter is the next source adapter. For now, download/open that PDF normally or use 'Open a PDF from my computer'.";
    return;
  }

  if (sourceUrl) {
    const access = await ensureHostAccess(sourceUrl);
    if (!access.ok) {
      $("message").className = "card status err";
      $("message").textContent = `AttachmentGuard needs read access to this PDF host before it can load the document. Permission was not granted.${access.pattern ? `\nRequested: ${access.pattern}` : ""}`;
      return;
    }
  }

  const editorUrl = chrome.runtime.getURL(`editor.html?${params.toString()}`);
  await chrome.tabs.update(currentTab.id, { url: editorUrl });
}

function renderCandidates(items) {
  const unique = [];
  const seen = new Set();

  if (currentTab?.url && looksPdf(currentTab.url)) {
    unique.push({ url: currentTab.url, kind: "current tab" });
    seen.add(currentTab.url);
  }
  for (const item of items) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }

  detected = unique;
  const box = $("candidates");
  if (!unique.length) {
    box.className = "status muted";
    box.innerHTML = "No obvious PDF URL was detected on this page.<br><br>You can still try the current tab URL or open a local PDF.";
    return;
  }

  box.className = "";
  box.innerHTML = unique.map((item, i) => `
    <div class="candidate">
      <b>${escapeHtml(labelFor(item.url, item.kind))}${item.url.startsWith("blob:") ? '<span class="pill">BLOB</span>' : ""}</b>
      <div class="url">${escapeHtml(item.url)}</div>
      <button class="primary" data-edit-index="${i}">${item.url.startsWith("blob:") ? "Blob source info" : "Edit this PDF"}</button>
    </div>
  `).join("");

  box.querySelectorAll("[data-edit-index]").forEach(btn => {
    btn.onclick = () => openEditor(unique[Number(btn.dataset.editIndex)].url);
  });
}

async function detect() {
  currentTab = await activeTab();
  if (!currentTab) {
    $("tabInfo").textContent = "No active tab.";
    return;
  }

  $("tabInfo").textContent = `${currentTab.title || "Untitled"}\n${currentTab.url || "URL unavailable"}`;
  $("candidates").className = "status muted";
  $("candidates").textContent = "Scanning page…";

  const items = currentTab.id ? await scanPage(currentTab.id) : [];
  renderCandidates(items);

  $("tryCurrentBtn").disabled = !currentTab.url || !/^https?:|^file:/i.test(currentTab.url);
}

$("refreshBtn").onclick = detect;
$("tryCurrentBtn").onclick = () => currentTab?.url && openEditor(currentTab.url);
$("localBtn").onclick = () => openEditor("");

detect();
