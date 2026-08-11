# AttachmentGuard Chrome Extension v0.3 — Native PDF Stream Handler

This version changes the Chrome integration layer, not the PDFium editor core.

## Why v0.3 exists

Chrome 151 introduced the public `chrome.mimeHandler` API. AttachmentGuard now registers for `application/pdf`, so Chrome can hand the extension the PDF response stream directly instead of trying to inspect Chrome's built-in PDF viewer.

For real `application/pdf` documents this removes the fragile "detect the PDF viewer page and fetch the URL again" approach.

## What Chrome now gives AttachmentGuard

When Chrome loads a real PDF document, AttachmentGuard receives:
- the original URL,
- the actual response stream URL,
- response headers,
- whether the PDF is embedded,
- the tab ID.

The stream is read once into memory and then passed to the existing PDFium editor.

## Supported by this foundation

- top-level PDF navigations
- PDFs opened from links
- PDFs delivered through POST or single-use URLs
- embedded PDF frames (`embed`, `object`, `iframe`) because `can_embed` is enabled
- local PDF files handled as PDF documents
- existing manual file picker fallback
- existing PDFium/font verification/editor features

## Honest boundary

This handles documents Chrome recognizes as `application/pdf` occupying a frame. A website that renders pages into its own canvas/images and never exposes a PDF MIME stream is not a PDF document from Chrome's MIME-handler perspective; that type of custom viewer needs a source adapter.

## Safety

If AttachmentGuard cannot initialize/render a MIME-handled PDF, it asks Chrome to fall back to the native PDF viewer rather than trapping the user on a broken page.
