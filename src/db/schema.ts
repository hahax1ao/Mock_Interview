import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const materials = sqliteTable("materials", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category").notNull(),
  mimeType: text("mime_type").notNull(),
  filePath: text("file_path").notNull(),
  status: text("status").notNull().default("ready"),
  contentHash: text("content_hash"),
  parseStatus: text("parse_status").default("ready"),
  createdAt: integer("created_at").notNull(),
});

export const materialChunks = sqliteTable("material_chunks", {
  id: text("id").primaryKey(),
  materialId: text("material_id").notNull().references(() => materials.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  page: integer("page").notNull(),
  text: text("text").notNull(),
  start: integer("start").notNull(),
  end: integer("end").notNull(),
});

export const profileFacts = sqliteTable("profile_facts", {
  id: text("id").primaryKey(),
  materialId: text("material_id").references(() => materials.id, { onDelete: "cascade" }),
  field: text("field").notNull(),
  value: text("value").notNull(),
  source: text("source").notNull(),
  confidence: real("confidence").notNull(),
  evidence: text("evidence").default(""),
  page: integer("page").default(1),
  extractor: text("extractor").default("local"),
  confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
});

export const interviews = sqliteTable("interviews", {
  id: text("id").primaryKey(),
  status: text("status").notNull(),
  duration: integer("duration").notNull(),
  focus: text("focus").notNull(),
  pressure: text("pressure").notNull(),
  materialIds: text("material_ids", { mode: "json" }).$type<string[]>().notNull(),
  plan: text("plan", { mode: "json" }).$type<unknown>().notNull(),
  startedAt: integer("started_at"),
  finishedAt: integer("finished_at"),
  reviewLeaseUntil: integer("review_lease_until"),
  createdAt: integer("created_at").notNull(),
});

export const interviewEvents = sqliteTable("interview_events", {
  id: text("id").primaryKey(),
  interviewId: text("interview_id").notNull().references(() => interviews.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  payload: text("payload", { mode: "json" }).$type<unknown>().notNull(),
  createdAt: integer("created_at").notNull(),
});

export const reviewReports = sqliteTable("review_reports", {
  id: text("id").primaryKey(),
  interviewId: text("interview_id").notNull().references(() => interviews.id, { onDelete: "cascade" }),
  status: text("status").notNull(),
  report: text("report", { mode: "json" }).$type<unknown>(),
  error: text("error"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
