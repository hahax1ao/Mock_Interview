import { readFile } from "node:fs/promises";
import { join } from "node:path";

const workerPath = join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs");
let embeddedWorker: Promise<string> | undefined;

export function getEmbeddedPdfWorker() {
  embeddedWorker ??= readFile(/* turbopackIgnore: true */ workerPath, "utf8")
    .then((source) => Buffer.from(source).toString("base64"))
    .then((encoded) => `data:text/javascript;base64,${encoded}`);
  return embeddedWorker;
}
