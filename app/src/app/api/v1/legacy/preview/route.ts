import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { legacyPreviewRequestSchema } from "@/contracts/legacy";
import { previewLegacy } from "@/workflows/legacy";
import { readLegacyBody } from "@/workflows/legacy-http";
import { errorResponse, HttpError, parseJson, withReferenceCheck } from "@/workflows/http";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  let raw: string;
  try { raw = await readLegacyBody(request); } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.code, e.message, e.status); throw e;
  }
  const json = parseJson(raw); if (!json.ok) return json.response;
  const parsed = legacyPreviewRequestSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "旧快照格式不兼容", 422, parsed.error.issues);
  return withReferenceCheck(() => NextResponse.json({ preview: previewLegacy(parsed.data) }));
}
