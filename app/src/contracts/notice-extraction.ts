import { z } from "zod";
import { noticeStructuredSchema } from "./inbox";
export const NOTICE_EXTRACTION_JOB_TYPE = "notice-extraction";
export const noticeExtractionSchema = z.object({
  structured: noticeStructuredSchema.nullable(),
  actionQuote: z.string().max(5000).nullable(),
  dueQuote: z.string().max(1000).nullable(),
  unknownReason: z.string().max(2000).nullable(),
});
export type NoticeExtraction = z.infer<typeof noticeExtractionSchema>;
