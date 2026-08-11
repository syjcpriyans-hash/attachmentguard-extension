# AttachmentGuard Chrome Extension v0.1

## Product direction

AttachmentGuard is no longer tied to Gmail or Zoho.

The Chrome extension detects PDFs in the user's current browser workflow and routes them into the same professional PDFium editor core.

### v0.1 source adapters
- Direct PDF URL in the current Chrome tab
- PDF URL found in `<embed>`, `<object>`, `<iframe>`, PDF links, and obvious PDF network resources on normal web pages
- Local PDF through the editor's file picker
- HTTP/HTTPS source permission requested only for the specific PDF origin

### Deliberately not faked in v0.1
- `blob:` PDF capture: detected and clearly reported, but not yet captured
- Universal server overwrite / “save back” to every website: impossible without each site's upload/API workflow
- DOCX/XLSX/PPTX: separate document engines, not part of the PDFium core

## Core that remains unchanged
- PDFium WebAssembly
- True existing PDF text-object editing
- Embedded/subset font handling
- Font Vault
- Exact-font resolution
- Strict save/reopen verification
- Verified search/replace
- Undo/redo
- Atomic replace-all

## Extension security
- Manifest V3
- PDFium and all JavaScript bundled inside the extension
- No runtime CDN code
- `activeTab` for user-invoked access
- site access requested only when the user chooses a PDF source
- PDF processing stays inside the browser/editor

## How to build without VS Code

Upload this source repository to GitHub.

GitHub Actions automatically:
1. installs the exact npm dependencies,
2. bundles the extension with Vite,
3. copies `pdfium.wasm` into the extension,
4. validates the WASM file,
5. creates `AttachmentGuard-Chrome-Extension.zip`,
6. exposes it as a downloadable Actions artifact.

See `INSTALL-STEPS.txt`.
