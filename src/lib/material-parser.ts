import { extname } from "node:path";
import mammoth from "mammoth";
import { createWorker } from "tesseract.js";
import { getEmbeddedPdfWorker } from "./pdf-worker";

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

const factPatterns: Array<[string, RegExp]> = [
  ["专业排名", /(?:专业)?排名[：:\s]*([^，。\n]{1,24})/i],
  ["平均成绩", /(?:均分|平均成绩|GPA)[：:\s]*([\d.\/]+)/i],
  ["英语四级", /(?:CET[- ]?4|四级)[：:\s]*(\d{3,})/i],
  ["英语六级", /(?:CET[- ]?6|六级)[：:\s]*(\d{3,})/i],
  ["目标方向", /(?:研究方向|目标方向)[：:\s]*([^，。\n]{2,40})/i],
  ["核心课程", /(?:核心课程|主修课程|相关课程)[：:\s]*([^。\n]{2,100})/i],
  ["项目经历", /(?:项目经历|课程设计|项目名称)[：:\s]*([^。\n]{2,100})/i],
  ["科研经历", /(?:科研经历|科研项目|研究经历)[：:\s]*([^。\n]{2,100})/i],
  ["竞赛经历", /(?:竞赛经历|获奖情况|学科竞赛)[：:\s]*([^。\n]{2,100})/i],
  ["技能", /(?:专业技能|技能|技术栈)[：:\s]*([^。\n]{2,100})/i],
];

export function extractFacts(pages: ParsedPage[], source: string, materialId: string) {
  const text = pages.map((page) => page.text).join("\n");
  return factPatterns.flatMap(([field, pattern], index) => {
    const match = text.match(pattern);
    return match ? [{
      id: crypto.randomUUID(),
      materialId,
      field,
      value: match[1].trim(),
      source,
      confidence: 0.78 - index * 0.02,
      confirmed: false,
    }] : [];
  });
}
