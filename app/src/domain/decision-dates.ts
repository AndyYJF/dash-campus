import { z } from "zod";
import { dateFromText } from "./task-text";

/** A source date describes what needs moving; it grants no destination or write permission. */
export const sourceDatesSchema = z.array(z.object({ date: z.iso.date(), excerpt: z.string().trim().min(1).max(100) }).strict()).max(8).default([]);

/** Accept semantic hints only when the cited literal date is actually in owner text. */
export function sourceDateExclusions(candidates: unknown, ownerText: string, referenceDate: string): string[] {
  const parsed = sourceDatesSchema.safeParse(candidates);
  if (!parsed.success) return [];
  return [...new Set(parsed.data.filter((c) => ownerText.includes(c.excerpt) && dateFromText(c.excerpt, referenceDate) === c.date).map((c) => c.date))];
}
