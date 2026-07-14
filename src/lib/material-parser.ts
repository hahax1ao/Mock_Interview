import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import mammoth from "mammoth";
import { createWorker } from "tesseract.js";
import { getEmbeddedPdfWorker } from "./pdf-worker";
import { extractLocalFacts } from "./profile-extraction";

export interface ParsedPage {
  page: number;
  text: string;
}

async function parsePdf(buffer: Buffer): Promise<ParsedPage[]> {
  const pdf: any = await import("pdf-parse");
  if (pdf.PDFParse) {
    pdf.PDFParse.setWorker(await getEmbeddedPdfWorker());
    const parser = new pdf.PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      if (Array.isArray(result.pages)) {
        return result.pages.map((page: any, index: number) => ({ page: index + 1, text: page.text ?? String(page) }));
      }
      return [{ page: 1, text: result.text ?? "" }];
    } finally {
      await parser.destroy?.();
    }
  }
  const result = await pdf.default(buffer);
  return [{ page: 1, text: result.text ?? "" }];
}

async function parseImage(buffer: Buffer): Promise<ParsedPage[]> {
  const worker = await createWorker(["chi_sim", "eng"]);
  try {
    const result = await worker.recognize(buffer);
    return [{ page: 1, text: result.data.text }];
  } finally {
    await worker.terminate();
  }
}

export async function parseMaterial(name: string, mimeType: string, buffer: Buffer): Promise<ParsedPage[]> {
  const extension = extname(name).toLowerCase();
  if (extension === ".txt" || extension === ".md" || mimeType.startsWith("text/")) {
    return [{ page: 1, text: buffer.toString("utf8") }];
  }
  if (extension === ".docx" || mimeType.includes("wordprocessingml")) {
    const result = await mammoth.extractRawText({ buffer });
    return [{ page: 1, text: result.value }];
  }
  if (extension === ".pdf" || mimeType === "application/pdf") return parsePdf(buffer);
  if ([".jpg", ".jpeg", ".png"].includes(extension) || mimeType.startsWith("image/")) return parseImage(buffer);
  throw new Error("仅支持 PDF、DOCX、JPG、PNG、TXT 和 Markdown");
}

export function extractFacts(pages: ParsedPage[], source: string, materialId: string) {
  return extractLocalFacts(pages, source).map((fact) => ({
    ...fact,
    id: randomUUID(),
    materialId,
    confirmed: false,
  }));
}

export { extractLocalFacts } from "./profile-extraction";
