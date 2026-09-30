import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { candidateActionSchema } from "@/contracts/exploration";
import { getCandidate, getEvidenceByIds, updateCandidateRow } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";
import { readyToStart } from "@/workflows/candidates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/candidates/:id —— 候选 + 引用证据（取回状态与条件确认状态分开表达，7.2） */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const candidate = getCandidate(id);
  if (!candidate) return notFound404("候选不存在");
  const evidence = getEvidenceByIds([...new Set(candidate.sourceRefs.map((r) => r.evidenceId))]).map((e) => ({
    id: e.id,
    url: e.url,
    title: e.title,
    status: e.status,
    retrievedAt: e.retrievedAt,
    publishedAt: e.publishedAt,
  }));
  return NextResponse.json({ candidate: { ...candidate, readyToStart: readyToStart(candidate) }, evidence });
}

/** PATCH：保存为想法 / 不采纳（附反馈）。反馈只影响当前推荐，不改长期画像（产品计划 7.5） */
export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = candidateActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const c = getCandidate(id);
  if (!c) return notFound404("候选不存在");
  if (c.status === "started") return errorResponse("ALREADY_STARTED", "候选已开始为项目", 409);
  const updated = updateCandidateRow(id, parsed.data.expectedVersion, {
    status: parsed.data.action === "save_idea" ? "idea" : "dismissed",
    feedback: parsed.data.feedback,
  });
  if (!updated) return conflict409();
  return NextResponse.json({ candidate: updated });
}
