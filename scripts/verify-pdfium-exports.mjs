import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const wasmPath = resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm");
const bytes = await readFile(wasmPath);
const mod = await WebAssembly.compile(bytes);
const exported = new Set(WebAssembly.Module.exports(mod).map(x => x.name));

const required = [
  "_FPDFText_LoadPage",
  "_FPDFText_CountChars",
  "_FPDFText_GetUnicode",
  "_FPDFText_GetTextObject",
  "_FPDFText_GetCharBox",
  "_FPDFText_GetCharOrigin",
  "_FPDFText_GetCharAngle",
  "_FPDFText_HasUnicodeMapError",
  "_FPDFText_FindStart",
  "_FPDFText_FindNext",
  "_FPDFText_GetSchResultIndex",
  "_FPDFText_GetSchCount",
  "_FPDFText_FindClose",
  "_FPDFText_SetText",
  "_FPDFPage_GenerateContent",
];

const missing = required.filter(name => !exported.has(name));
if (missing.length) {
  console.error("AttachmentGuard PDFium compatibility FAILED.");
  console.error("Missing WASM exports:", missing.join(", "));
  process.exit(1);
}
console.log(`AttachmentGuard PDFium compatibility PASS — ${required.length} required exports found.`);
