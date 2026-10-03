import { z } from "zod";
import { localTimeSchema } from "./calendar";
export const DIGEST_JOB_TYPE = "digest";
export const digestSettingsSchema = z.object({
  dailyEnabled: z.boolean().default(false), dailyTime: localTimeSchema.default("08:30"),
  weeklyEnabled: z.boolean().default(false), weeklyWeekday: z.number().int().min(1).max(7).default(1), weeklyTime: localTimeSchema.default("08:00"),
  systemEnabled: z.boolean().default(false),
});
export type DigestSettings = z.infer<typeof digestSettingsSchema>;
export type DigestKind = "daily" | "weekly" | "system";
export const DIGEST_SETTINGS_KEY = "digestSettings";
