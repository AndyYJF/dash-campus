import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { getDigestSettings } from "@/workflows/digests";
import { updateSetting } from "@/repositories/settings";
import { DIGEST_SETTINGS_KEY, digestSettingsSchema } from "@/contracts/digests";
import { errorResponse, conflict409 } from "@/workflows/http";
export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { const auth = requireOwner(request); if (!auth.ok) return auth.response; return NextResponse.json(getDigestSettings()); }
export async function PUT(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const p = digestSettingsSchema.extend({ expectedVersion: z.number().int().min(0) }).safeParse(await request.json().catch(() => null));
  if (!p.success) return errorResponse("VALIDATION", "摘要通知设置不合法", 422);
  const { expectedVersion, ...settings } = p.data;
  if (updateSetting(DIGEST_SETTINGS_KEY, settings, expectedVersion) === "conflict") return conflict409();
  return NextResponse.json(getDigestSettings());
}
