import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { legacyApplyRequestSchema } from "@/contracts/legacy";
import { applyLegacy } from "@/workflows/legacy";
import { readLegacyBody } from "@/workflows/legacy-http";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";

export const dynamic = "force-dynamic";
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  let raw: string;
  try { raw = await readLegacyBody(request); } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.code, e.message, e.status); throw e;
  }
  const json = parseJson(raw); if (!json.ok) return json.response;
  const parsed = legacyApplyRequestSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "需确认有效的导入预览", 422, parsed.error.issues);
  return runIdempotent(request, raw, { actorScope: `owner:${auth.session.ownerId}`, route: "legacy/apply", execute: () => {
    const receipt = applyLegacy(parsed.data);
    return { statusCode: 201, body: { receipt }, resourceType: "legacy_import", resourceId: receipt.id };
  } });
}
