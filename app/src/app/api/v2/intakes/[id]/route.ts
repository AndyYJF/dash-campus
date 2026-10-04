import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";
import { getIntake, listExtractedDocuments, listItems } from "@/repositories/intakes";
import { listQuestionsForIntake } from "@/repositories/questions";
import { intakeResultView } from "@/workflows/results";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v2/intakes/:id —— 各事项/阶段、必要问题、结果版本与来源；不暴露 job 租约等实现细节 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const intake = getIntake(id);
  if (!intake) return notFound404("这条投递不存在");

  const items = listItems(id).map((i) => ({
    id: i.id,
    kind: i.kind,
    state: i.state,
    summary: (i.payload.summary as string | undefined) ?? null,
    candidate: (i.payload.candidate as unknown | undefined) ?? null,
    error: (i.evidence?.error as string | undefined) ?? null,
    evidence: i.evidence && !i.evidence.error ? i.evidence : null,
    waitingQuestionId: i.waitingQuestionId,
    version: i.version,
  }));
  const questions = listQuestionsForIntake(id).map((q) => ({
    id: q.id,
    questionKey: q.questionKey,
    fieldPath: q.fieldPath,
    prompt: q.prompt,
    status: q.status,
    version: q.version,
    purpose: q.purpose,
    reason: q.reason,
    options: q.options ?? [],
  }));
  const documents = listExtractedDocuments(id).filter((d) => d.sourceKind !== "owner-rest").map((d) => ({
    id: d.id,
    sourceKind: d.sourceKind,
    status: d.status,
  }));

  return NextResponse.json({
    intake: {
      id: intake.id,
      status: intake.status,
      referenceDate: intake.referenceDate,
      timezone: intake.timezone,
      lastError: intake.lastError,
      version: intake.version,
      createdAt: intake.createdAt,
    },
    text: intake.text,
    documents,
    items,
    questions,
    // 统一业务结果：实际变更、下一步/阻碍、待答问题、后续状态与撤销入口
    result: intakeResultView(intake),
  });
}
