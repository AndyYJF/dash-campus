import { z } from "zod";
const localDate = z.iso.date();
const httpUrl = z.string().url().refine((url) => /^https?:\/\//.test(url), "URL只允许http/https");

export const recordVersion = z.object({ expectedVersion: z.number().int().min(1) });
const logFields = z.object({ occurredOn: localDate, progress: z.string().max(5000), blocker: z.string().max(5000),
  taskId: z.string().uuid().nullable(), projectId: z.string().uuid().nullable() });
export const logPatchSchema = logFields.partial().extend(recordVersion.shape);
export const artifactFields = z.object({ projectId: z.string().uuid(), logId: z.string().uuid().nullable(),
  kind: z.enum(["text", "link"]), title: z.string().trim().min(1).max(200), body: z.string().max(10000), url: httpUrl.nullable() });
export const artifactPatchSchema = artifactFields.partial().extend(recordVersion.shape);
export const resourceFields = z.object({ kind: z.enum(["text", "url"]), title: z.string().trim().min(1).max(200),
  body: z.string().max(20000), url: httpUrl.nullable(),
  sourceYear: z.number().int().min(1900).max(2200).nullable(), sourceKind: z.enum(["user_supplied", "official", "other"]) });
export const resourceCreateSchema = resourceFields.extend({ body: resourceFields.shape.body.default(""), url: resourceFields.shape.url.default(null), sourceYear: resourceFields.shape.sourceYear.default(null), sourceKind: resourceFields.shape.sourceKind.default("user_supplied") }).refine((v) => v.kind === "url" ? Boolean(v.url) : Boolean(v.body.trim()), "链接资料需填写URL，文本资料需填写正文");
export const resourcePatchSchema = resourceFields.partial().extend(recordVersion.shape);
