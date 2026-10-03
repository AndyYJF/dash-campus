import { z } from 'zod';
import { timezoneSchema } from './calendar';

export const timetableInputSchema = z.object({
  text: z.string().trim().min(1).max(64_000),
  firstMonday: z.iso.date().refine(d => new Date(`${d}T00:00:00Z`).getUTCDay() === 1, '第一教学周日期必须是周一'),
  timezone: timezoneSchema,
});
export const timetableImportSchema = timetableInputSchema.extend({ expectedRevision: z.number().int().min(0) });
export type TimetableInput = z.infer<typeof timetableInputSchema>;
