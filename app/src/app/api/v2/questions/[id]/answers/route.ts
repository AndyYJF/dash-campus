import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";
import { answerSubmitSchema } from "@/contracts/intake";
import { submitAnswer } from "@/workflows/intake";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/v2/questions/:id/answers（MASTER-PLAN §8）：
 * 幂等 + expectedVersion；答案先持久化再恢复依赖分支，202 表示已接收。
 */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const raw = await request.text();
  const json = parseJson(raw);
  if (!json.ok) return json.response;
  const parsed = answerSubmitSchema.safeParse(json.value);
  if (!parsed.success) {
    return errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422);
  }
  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: `v2.questions.answer:${id}`,
    execute: () => {
      const r = submitAnswer({
        questionId: id,
        expectedVersion: parsed.data.expectedVersion,
        text: parsed.data.text,
        optionIndex: parsed.data.optionIndex,
      });
      if (r.kind === "unparseable") {
        // 不抛错回滚：答非所问的这句话要留在对话里，问题保持 open，并给出更具体的提示
        return { statusCode: 422, body: { error: { code: "ANSWER_UNPARSEABLE", message: `没看懂这个回答。${r.hint}` } }, resourceType: null, resourceId: null };
      }
      if (r.kind === "stale") {
        throw new HttpError(409, "STALE_ANSWER", "问题已更新，请刷新后按最新问题回答", { retryable: false });
      }
      if (r.kind === "not_open") {
        throw new HttpError(409, "QUESTION_NOT_OPEN", "该问题已回答或已失效，无需重复回答");
      }
      return {
        statusCode: 202,
        body: { questionId: id, status: r.question.status, version: r.question.version, results: r.results, note: r.note },
        resourceType: "clarification_answer",
        resourceId: id,
      };
    },
  });
}
