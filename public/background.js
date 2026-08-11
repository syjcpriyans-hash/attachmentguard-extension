chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.runtime.sendMessage({
      type: "ATTACHMENTGUARD_TOGGLE_EDIT",
      tabId: tab?.id ?? null,
    });
  } catch {
    // No AttachmentGuard viewer is active in this tab.
  }
});
