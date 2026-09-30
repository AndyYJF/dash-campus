import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getRun, listCandidatesByRun, listEvidence, listHits } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";
import { readyToStart } from "@/workflows/candidates";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/explorations/:id —— 实际阶段、预算、诊断、证据与候选（证据正文截断展示） */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const run = getRun(id);
  if (!run) return notFound404("探索记录不存在");
  const evidence = listEvidence(id).map((e) => ({
    id: e.id,
    url: e.url,
    title: e.title,
    status: e.status,
    publishedAt: e.publishedAt,
    retrievedAt: e.retrievedAt,
    excerpt: e.text.slice(0, 600),
    length: e.text.length,
  }));
  const candidates = listCandidatesByRun(id).map((c) => ({ ...c, readyToStart: readyToStart(c) }));
  return NextResponse.json({ run, hits: listHits(id), evidence, candidates });
}
