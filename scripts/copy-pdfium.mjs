import { mkdir, copyFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const source = resolve("node_modules/@embedpdf/pdfium/dist/pdfium.wasm");
const dir = resolve("public/assets");
const target = resolve(dir, "pdfium.wasm");

await mkdir(dir, { recursive: true });
await copyFile(source, target);

const info = await stat(target);
if (info.size < 1_000_000) {
  throw new Error(`pdfium.wasm looks invalid (${info.size} bytes)`);
}
console.log(`AttachmentGuard extension: packaged PDFium WASM (${info.size.toLocaleString()} bytes)`);
