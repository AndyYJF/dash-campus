import { z } from "zod";
export const AI_NEWS_JOB_TYPE = "ai_news";
export const AI_NEWS_POLICY_KEY = "aiNewsPolicy";
export const AI_NEWS_SCHEDULE_KEY = "aiNewsScheduleDate";
export const NEWS_CATEGORIES = [
  "model",
  "agent",
  "research",
  "application",
] as const;
export const NEWS_LABELS: Record<(typeof NEWS_CATEGORIES)[number], string> = {
  model: "模型",
  agent: "Agent",
  research: "科研",
  application: "应用",
};
export const newsPolicySchema = z.object({
  enabled: z.boolean().default(true),
  localTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("08:00"),
  days: z.number().int().min(1).max(30).default(7),
});
export type NewsPolicy = z.infer<typeof newsPolicySchema>;
export type NewsSource = {
  id: string;
  title: string;
  url: string;
  publisher: string;
  publishedAt: string | null;
  retrievedAt: string;
  text: string;
  evidence: "feed" | "snippet";
};
export const newsDigestSchema = z.object({
  stories: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(180),
        category: z.enum(NEWS_CATEGORIES),
        summary: z.string().trim().min(1).max(600),
        relevance: z.string().trim().min(1).max(500),
        uncertainty: z.string().max(300).default(""),
        citations: z
          .array(
            z.object({
              sourceId: z.string().min(1).max(64),
              quote: z.string().trim().min(8).max(350),
            }),
          )
          .min(1)
          .max(3),
      }),
    )
    .max(12),
});
export type NewsDigest = z.infer<typeof newsDigestSchema>;
export type NewsRun = {
  id: string;
  trigger: "manual" | "scheduled";
  status: "queued" | "running" | "ready" | "empty" | "failed" | "cancelled";
  days: number;
  policyVersion: number;
  jobId: string | null;
  sources: NewsSource[];
  digest: NewsDigest | null;
  warnings: string[];
  integrationMode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  generatedAt: string | null;
};
