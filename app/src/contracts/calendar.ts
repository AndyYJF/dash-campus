import { z } from 'zod';
export const timezoneSchema = z.string().min(1).refine(tz => { try { new Intl.DateTimeFormat('en',{timeZone:tz}); return true; } catch { return false; } }, '时区无效');
export const localTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const calendarSchema = z.object({
 title:z.string().trim().min(1).max(200), weekday:z.number().int().min(1).max(7),
 localStart:localTimeSchema,localEnd:localTimeSchema,timezone:timezoneSchema,
 validFrom:z.iso.date().nullable().default(null),validUntil:z.iso.date().nullable().default(null),eventDate:z.iso.date().nullable().default(null),
}).refine(d=>d.localStart<d.localEnd,'结束时间必须晚于开始时间').refine(d=>!d.validFrom||!d.validUntil||d.validFrom<=d.validUntil,'有效期结束不能早于开始');
export const calendarExceptionSchema=z.object({localDate:z.iso.date(),cancelled:z.boolean(),localStart:localTimeSchema.nullable().default(null),localEnd:localTimeSchema.nullable().default(null),expectedVersion:z.number().int().min(0)}).refine(d=>d.cancelled||Boolean(d.localStart&&d.localEnd&&d.localStart<d.localEnd),'替换活动需要完整起止时间');
export type CalendarInput = z.infer<typeof calendarSchema>;
