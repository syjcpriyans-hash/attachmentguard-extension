async function rememberInvocation(tab) {
  if (!tab?.id) return null;
  const context = {
    id: tab.id,
    windowId: tab.windowId,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title || "",
    capturedAt: Date.now(),
  };
  await chrome.storage.session.set({ attachmentGuardInvocation: context });
  return context;
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    await rememberInvocation(tab);
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.error("AttachmentGuard action failed:", error);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "ATTACHMENTGUARD_GET_INVOCATION") {
    chrome.storage.session.get("attachmentGuardInvocation")
      .then(({ attachmentGuardInvocation }) => sendResponse({ ok: true, context: attachmentGuardInvocation || null }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }
});
