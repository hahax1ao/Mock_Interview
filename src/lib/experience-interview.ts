import { eq, inArray } from "drizzle-orm";
import { db, initDatabase } from "@/db/client";
import { interviews, profileExperiences } from "@/db/schema";
import type { ProfileExperience } from "@/domain/experiences";

export function selectCoreExperience(
  experiences: ProfileExperience[],
  focus: string,
): ProfileExperience | undefined {
  return experiences
    .filter((experience) => experience.status === "confirmed")
    .map((experience) => ({
      experience,
      quantitativeResult: /\d/.test(experience.results),
      completeness: [experience.background, experience.responsibilities, experience.methods, experience.results, experience.awardRole]
        .filter((detail) => detail.trim().length > 0).length,
      relevance: relevanceScore([
        experience.title,
        experience.background,
        experience.responsibilities,
        experience.methods,
        experience.results,
        experience.awardRole,
      ].join(" "), focus),
    }))
    .sort((a, b) => b.relevance - a.relevance
      || b.completeness - a.completeness
      || Number(b.quantitativeResult) - Number(a.quantitativeResult)
      || b.experience.createdAt - a.experience.createdAt
      || a.experience.id.localeCompare(b.experience.id))[0]?.experience;
}

function relevanceScore(text: string, query: string) {
  const normalized = query.toLowerCase().replace(/\s+/g, "");
  const candidate = text.toLowerCase().replace(/\s+/g, "");
  if (!normalized) return 0;
  if (candidate.includes(normalized)) return 100 + normalized.length;
  let score = 0;
  for (let size = Math.min(4, normalized.length); size > 0; size--) {
    for (let index = 0; index <= normalized.length - size; index++) {
      if (candidate.includes(normalized.slice(index, index + size))) score += size * size;
    }
  }
  return score;
}

const EXPERIENCE_TYPE_LABEL: Record<ProfileExperience["type"], string> = {
  research: "科研",
  project: "项目",
  competition: "竞赛",
};

function formatExperience(experience: ProfileExperience, heading: string) {
  return [
    `${heading} 类型：${EXPERIENCE_TYPE_LABEL[experience.type]} 名称：${experience.title}`,
    experience.background && `背景目标：${experience.background}`,
    experience.responsibilities && `个人职责：${experience.responsibilities}`,
    experience.methods && `技术方法：${experience.methods}`,
    experience.results && `量化成果：${experience.results}`,
    experience.awardRole && `奖项角色：${experience.awardRole}`,
    `来源：${experience.source} 第 ${experience.page} 页`,
  ].filter(Boolean).join("\n");
}

export function formatCoreExperience(experience: ProfileExperience) {
  return formatExperience(experience, "【已确认核心经历】");
}

export function formatConfirmedExperience(experience: ProfileExperience) {
  return formatExperience(experience, "【已确认经历】");
}
export async function buildResearchHandoffInstruction(interviewId: string) {
  await initDatabase();
  const [interview] = await db.select().from(interviews).where(eq(interviews.id, interviewId));
  if (!interview?.materialIds.length) return undefined;
  const experiences = await db.select().from(profileExperiences)
    .where(inArray(profileExperiences.materialId, interview.materialIds));
  const core = selectCoreExperience(experiences, interview.focus);
  if (!core) return undefined;
  return [
    formatCoreExperience(core),
    "科研项目模块的第一问必须点名这项经历并询问候选人的个人职责。后续按动机与职责、技术方法、实验结果、局限与改进追问；同一主题最多三层。",
  ].join("\n");
}