# AttachmentGuard v0.5 — Reliable Inline Commit + Editable Filename

This is an incremental reliability release on top of the working v0.4 native-look PDF viewer.
The PDFium/font engine architecture is unchanged.

## Fixed: first-Enter commit reliability

Inline editing now has one transaction path shared by:
- Enter
- the visible ✓ save button

Reliability protections:
- commit lock prevents duplicate Enter/key-repeat transactions
- composition/IME-safe Enter handling
- latest input value is read after a microtask
- inline input stays visible until PDFium save/reopen verification passes
- failed verification keeps the user's typed correction in place
- if an exact font is required, the typed correction is preserved while font resolution runs
- canceling the font-resolution dialog returns to the same typed inline edit instead of forcing the user to start again

## Added: editable filename

The filename in the top-left toolbar is now an input.
Click it, type the desired output name, and press Enter or click elsewhere.

AttachmentGuard:
- removes characters illegal in Windows filenames
- ensures `.pdf`
- prevents reserved Windows device names
- uses the edited filename in `chrome.downloads.download`
- opens Chrome Save As with that filename pre-filled

Ctrl+S also saves using the current edited filename.

## Test

1. Open a PDF.
2. Click pencil.
3. Click a text object.
4. Type a replacement.
5. Press Enter ONCE.
6. It should either:
   - save and show `Saved ✓ — verified PDF edit`, or
   - keep the exact typed edit visible and explain the precise verification/font blocker.
   It should never silently discard the typed correction.
7. Rename the PDF in the top-left filename field.
8. Press Enter.
9. Click Save.
10. Chrome's Save As dialog should be pre-filled with the new filename.
