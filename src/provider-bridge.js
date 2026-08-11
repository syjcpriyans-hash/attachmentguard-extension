/**
 * Stable attachment handoff boundary.
 * The PDF/editor engine should never need to know whether the caller is
 * Browser Download, Zoho Mail, Gmail, Outlook, or another provider.
 */
export class BrowserAttachmentBridge {
  constructor() {
    this.provider = "browser";
    this.canReplaceActiveDraftAttachment = false;
  }

  async prepare({ bytes, fileName }) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    return {
      provider: this.provider,
      fileName,
      blob,
      url,
      revoke: () => URL.revokeObjectURL(url),
    };
  }

  async deliver({ bytes, fileName }) {
    const handoff = await this.prepare({ bytes, fileName });
    const a = document.createElement("a");
    a.href = handoff.url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(handoff.revoke, 1500);
    return { ok: true, provider: this.provider, fileName };
  }
}

export const attachmentBridge = new BrowserAttachmentBridge();
