import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAIL_SETTINGS_KEY,
  mailTemplateSettingsSchema,
  type MailTemplateSettings,
} from "@/contracts/mail";
import { getSetting } from "@/repositories/settings";
import { getMailTemplateSettings, saveMailTemplateSettings } from "@/workflows/mail-settings";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse } from "@/workflows/http";

export const dynamic = "force-dynamic";

const patchSchema = mailTemplateSettingsSchema
  .partial()
  .extend({ expectedVersion: z.number().int().min(0) });

/** GET /api/v1/settings —— 非秘密设置；T3 只有邮件模板配置项 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { version } = getSetting(MAIL_SETTINGS_KEY);
  return NextResponse.json({ settings: getMailTemplateSettings(), version });
}

/** PATCH /api/v1/settings —— expectedVersion 乐观锁，不匹配 409 */
export async function PATCH(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);

  const { expectedVersion, ...patch } = parsed.data;
  const merged = mailTemplateSettingsSchema.parse({
    ...getMailTemplateSettings(),
    ...patch,
  }) as MailTemplateSettings;
  const result = saveMailTemplateSettings(merged, expectedVersion);
  if (result === "conflict") return conflict409();
  return NextResponse.json({ settings: merged, version: result.version });
}
