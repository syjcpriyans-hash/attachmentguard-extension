# AttachmentGuard v0.4 — Native-Look Inline PDF Editing

This version intentionally removes the separate "editor website" experience.

## Product UX

1. User opens a PDF in Chrome.
2. AttachmentGuard handles the PDF stream.
3. The PDF opens in a Chrome-native-looking dark viewer:
   - thumbnails on the left
   - pages in the center
   - page counter and zoom toolbar
4. The user clicks the pencil icon (or AttachmentGuard toolbar icon).
5. Existing PDF text becomes directly clickable in place.
6. Click text → type directly over that text → Enter.
7. AttachmentGuard runs the strict PDFium transaction:
   - character/font preflight
   - true PDF object edit
   - page regeneration
   - save
   - reopen
   - Unicode audit
   - font/style/position verification
   - collision check
8. Only verified edits replace the working PDF.
9. Save opens Chrome's Save dialog for the corrected PDF.

## Important technical boundary

Chrome does not expose an API that allows a third-party extension to modify the built-in Chrome PDF viewer itself.
AttachmentGuard therefore uses Chrome's official PDF MIME handler and renders its own viewer designed to feel like the native viewer.

The original PDF URL remains in Chrome's address bar.

## Exact-font behavior

No silent substitution.
If the embedded PDF font cannot represent the new text:
- search same PDF
- search local Font Vault
- ask for exact installed font
- allow exact TTF/OTF upload
- otherwise block
