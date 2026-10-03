import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { campusTaskSchema, campusEnvelope, campusEvidenceText, campusEvidenceOccurredAt } from "@/domain/campus-bridge";
import { importCampusNotice } from "@/workflows/campus-bridge";
import { errorResponse, HttpError, parseJson } from "@/workflows/http";
import { readLegacyBody } from "@/workflows/legacy-http";

export const dynamic = "force-dynamic";
const schema = z.object({ source: z.string().min(1).max(100), task: campusTaskSchema });
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return errorResponse("UNAUTHORIZED", "需要来源 Bearer token", 401);
  let raw: string;
  try { raw = await readLegacyBody(request); } catch (e) { if (e instanceof HttpError) return errorResponse(e.code, e.message, e.status); throw e; }
  const json = parseJson(raw); if (!json.ok) return json.response;
  const parsed = schema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "插件事项格式不兼容", 422, parsed.error.issues);
  const envelope = (() => { try { return campusEnvelope(parsed.data.task, parsed.data.source); } catch { return null; } })();
  if (!envelope) return errorResponse("VALIDATION", "事项正文超过收件箱限制", 422);
  // Historical terminal items remain reviewable; do not spend the current-notice budget on a full history import.
  const result = importCampusNotice(envelope, auth.slice(7), campusEvidenceText(parsed.data.task), campusEvidenceOccurredAt(parsed.data.task), parsed.data.task.status === "open");
  if (!result.ok) return result.error === "source_forbidden" ? errorResponse("SOURCE_FORBIDDEN", "来源不存在、停用或 token 不匹配", 403)
    : errorResponse("SOURCE_REVISION_COLLISION", "上游相同 revision 内容不同，需核对上游修订", 409);
  return NextResponse.json(result, { status: result.kind === "created" ? 201 : 200 });
}
