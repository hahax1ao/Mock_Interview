import { z } from "zod";

export const ExperienceTypeSchema = z.enum(["research", "project", "competition"]);
export type ExperienceType = z.infer<typeof ExperienceTypeSchema>;

export const ExperienceEvidenceSchema = z.object({
  title: z.string().trim().min(1),
  background: z.string().trim().min(1).optional(),
  responsibilities: z.string().trim().min(1).optional(),
  methods: z.string().trim().min(1).optional(),
  results: z.string().trim().min(1).optional(),
  awardRole: z.string().trim().min(1).optional(),
}).strict();

export type ExperienceEvidence = z.infer<typeof ExperienceEvidenceSchema>;

export const ExperienceEditableObjectSchema = z.object({
  type: ExperienceTypeSchema,
  title: z.string().trim().min(1).max(300),
  background: z.string().trim().max(2_000).default(""),
  responsibilities: z.string().trim().max(2_000).default(""),
  methods: z.string().trim().max(4_000).default(""),
  results: z.string().trim().max(2_000).default(""),
  awardRole: z.string().trim().max(1_000).default(""),
});

export const experienceEditableSchema = ExperienceEditableObjectSchema.refine((value) => [
  value.background, value.responsibilities, value.methods, value.results, value.awardRole,
].some((field) => field.length > 0), { message: "详细经历至少需要一项描述" });

export type ExperienceEditable = z.infer<typeof ExperienceEditableObjectSchema>;

export type ProfileExperience = z.infer<typeof experienceEditableSchema> & {
  id: string;
  materialId: string;
  source: string;
  page: number;
  evidence: ExperienceEvidence;
  confidence: number;
  status: "draft" | "confirmed";
  createdAt: number;
  updatedAt: number;
};
