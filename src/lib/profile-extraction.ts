import type { ParsedPage } from "./material-parser";

export interface EvidenceFactInput {
  field: string;
  value: string;
  source: string;
  confidence: number;
  evidence: string;
  page: number;
  extractor: string;
}

interface LocalPattern {
  field: string;
  pattern: RegExp;
  confidence: number;
}

const localPatterns: LocalPattern[] = [
  {
    field: "专业排名",
    pattern: /(?:专业)?排名\s*[：:]?\s*(\d+\s*\/\s*\d+)/giu,
    confidence: 0.78,
  },
  {
    field: "平均成绩",
    pattern: /(?:均分|平均成绩|GPA)\s*[：:]?\s*(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)/giu,
    confidence: 0.76,
  },
  {
    field: "英语四级",
    pattern: /(?:CET\s*[- ]?\s*4|英语四级|四级)\s*[：:]?\s*(\d{3,})/giu,
    confidence: 0.74,
  },
  {
    field: "英语六级",
    pattern: /(?:CET\s*[- ]?\s*6|英语六级|六级)\s*[：:]?\s*(\d{3,})/giu,
    confidence: 0.72,
  },
  {
    field: "目标方向",
    pattern: /(?:研究方向|目标方向)\s*[：:]?\s*([^，,。；;]{1,40})/giu,
    confidence: 0.7,
  },
  {
    field: "核心课程",
    pattern: /(?:核心课程|主修课程|相关课程)\s*[：:]?\s*([^。；;]{1,100})/giu,
    confidence: 0.68,
  },
];

const normalize = (value: string) => value.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

const validValue = (value: string) => {
  const trimmed = value.trim();
  return trimmed.length > 0 && !/[：:]$/.test(trimmed);
};

export function mergeFacts(...groups: EvidenceFactInput[][]): EvidenceFactInput[] {
  const unique = new Map<string, EvidenceFactInput>();
  for (const fact of groups.flat()) {
    const key = `${normalize(fact.field)}\0${normalize(fact.value)}`;
    if (!unique.has(key)) unique.set(key, fact);
  }
  return [...unique.values()];
}

export function extractLocalFacts(pages: ParsedPage[], source: string): EvidenceFactInput[] {
  const facts: EvidenceFactInput[] = [];

  for (const page of pages) {
    for (const evidence of page.text.split(/\r?\n/)) {
      for (const { field, pattern, confidence } of localPatterns) {
        pattern.lastIndex = 0;
        for (const match of evidence.matchAll(pattern)) {
          const value = match[1]?.trim() ?? "";
          if (!validValue(value)) continue;
          facts.push({
            field,
            value,
            source,
            confidence,
            evidence,
            page: page.page,
            extractor: "local",
          });
        }
      }
    }
  }

  return mergeFacts(facts);
}
