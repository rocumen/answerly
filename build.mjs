import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const vendor = new URL("./vendor/", import.meta.url);
const pdfjs = new URL("./node_modules/pdfjs-dist/", import.meta.url);
await rm(vendor, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
await build({
  entryPoints: [fileURLToPath(new URL("./src/file-parser.js", import.meta.url))],
  outfile: fileURLToPath(new URL("./vendor/file-parser.js", import.meta.url)),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  legalComments: "eof"
});
await cp(new URL("./build/pdf.worker.min.mjs", pdfjs), new URL("./vendor/pdf.worker.min.mjs", import.meta.url));
await cp(new URL("./cmaps/", pdfjs), new URL("./vendor/cmaps/", import.meta.url), { recursive: true });
await cp(new URL("./standard_fonts/", pdfjs), new URL("./vendor/standard_fonts/", import.meta.url), { recursive: true });
await cp(new URL("./iccs/", pdfjs), new URL("./vendor/iccs/", import.meta.url), { recursive: true });
await mkdir(new URL("./vendor/licenses/", import.meta.url), { recursive: true });
for (const name of ["pdfjs-dist", "fflate", "fast-xml-parser"]) {
  await cp(new URL(`./node_modules/${name}/LICENSE`, import.meta.url), new URL(`./vendor/licenses/${name}-LICENSE`, import.meta.url));
}
console.log("Built the local file parser and copied PDF.js worker and font data into vendor/.");
