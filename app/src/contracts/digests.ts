import { z } from "zod";
import { localTimeSchema } from "./calendar";
export const DIGEST_JOB_TYPE = "digest";
/** 每天一次的有限重排（MASTER-PLAN §10 P5）：dedupe 按本地日期，错过不补跑 */
export const PLAN_MAINTENANCE_JOB_TYPE = "plan_maintenance";
export const digestSettingsSchema = z.object({
  dailyEnabled: z.boolean().default(false), dailyTime: localTimeSchema.default("08:30"),
  weeklyEnabled: z.boolean().default(false), weeklyWeekday: z.number().int().min(1).max(7).default(1), weeklyTime: localTimeSchema.default("08:00"),
  systemEnabled: z.boolean().default(false),
});
export type DigestSettings = z.infer<typeof digestSettingsSchema>;
export type DigestKind = "daily" | "weekly" | "system";
export const DIGEST_SETTINGS_KEY = "digestSettings";
