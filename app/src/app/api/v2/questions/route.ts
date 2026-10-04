import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { listOpenQuestions } from "@/repositories/questions";

export const dynamic = "force-dynamic";

/** GET /api/v2/questions —— open 必要问题；首屏最多 3 个（§2.3），total 供分页入口 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const all = listOpenQuestions();
  return NextResponse.json({
    questions: all.slice(0, 3).map((q) => ({
      id: q.id,
      questionKey: q.questionKey,
      fieldPath: q.fieldPath,
      prompt: q.prompt,
      options: q.options ?? [],
      purpose: q.purpose,
      reason: q.reason,
      version: q.version,
      createdAt: q.createdAt,
    })),
    totalOpen: all.length,
  });
}
