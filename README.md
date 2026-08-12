# AttachmentGuard v0.7 — Text Kernel v1

This release intentionally stops expanding features and replaces the old heuristic text-object grouping layer with a character-stream text kernel.

## Why

A visible word can be split across many PDF text objects. Conversely, one PDF text object can contain several visible words. PDF text objects therefore cannot be the end-user selection model.

Text Kernel v1 uses PDFium's character stream:
- Unicode per character
- page character index
- character bounding box
- character origin
- character rotation
- associated underlying PDF text object
- object-relative character offset

The UI is then built from complete **words**, not raw PDF objects.

## Edit algorithm

1. Click complete visible word.
2. Kernel maps every selected character back to the exact underlying PDF object + offset.
3. Build a transactional replacement plan.
4. Rewrite only the selected range:
   - preserve unrelated prefix/suffix text
   - preserve unrelated prefix/suffix characters in the underlying text object
   - verify after save that the complete primary object still contains the exact expected prefix + replacement + suffix
   - secondary fragmented objects must be fully selected or the edit is blocked
5. Save a temporary PDF.
6. Reopen it.
7. Find the replacement through PDFium's text search.
8. Verify Unicode + font/style/transform.
9. Render before/after with PDFium and compare pixels outside the edited region.
10. Commit only if every check passes.

## What is intentionally blocked

Text Kernel v1 blocks rather than guesses when:
- a single word contains mixed formatting
- rotated text needs rewriting
- PDF character offsets cannot be mapped to the underlying object
- a fragmented word crosses an object that also contains unrelated text
- exact font metrics are unavailable for a variable-length partial edit
- a replacement would overlap a fixed suffix or neighboring object
- post-save structural/pixel verification fails

These are product safeguards, not silent failures.

## Existing features retained

- native-looking PDF viewer
- Chrome PDF MIME handling
- direct inline editing
- exact-font resolver
- browser-local Font Vault
- editable output filename
- save/download
- undo
- Gmail / Zoho / Outlook mail-preview bridge


## PDFium compatibility gate

AttachmentGuard does not assume that every API documented in current upstream PDFium is present in the npm-packaged WASM.

Every GitHub build now compiles the actual `pdfium.wasm` module and verifies the exact exports the Text Kernel requires. A missing engine function makes the build RED before an extension artifact is produced.

This prevents us from shipping source code against an API that is not actually packaged in our production WASM.
