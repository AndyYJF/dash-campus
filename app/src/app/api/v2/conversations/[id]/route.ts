import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";
import { conversationExists, latestConversationId, listTurns } from "@/repositories/conversations";
import { listOpenQuestions } from "@/repositories/questions";
import { intakeResultById } from "@/workflows/results";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET /api/v2/conversations/:id（:id 可为 current）：有限分页恢复对话——主人原话、每条输入的结果、未答问题。
 * 纯读取；刷新或换设备后从这里继续，不靠浏览器本地记录。
 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const raw = (await ctx.params).id;
  const id = raw === "current" ? latestConversationId() : raw;
  const questions = listOpenQuestions(3).map((q) => ({ id: q.id, prompt: q.prompt, reason: q.reason, options: q.options ?? [], purpose: q.purpose, version: q.version, createdAt: q.createdAt }));
  if (!id) return NextResponse.json({ conversationId: null, turns: [], questions, nextBeforeSeq: null });
  if (!conversationExists(id)) return notFound404("这次对话不存在");
  const q = request.nextUrl.searchParams;
  const limit = Math.min(Math.max(Number(q.get("limit") ?? 20) || 20, 1), 50);
  const before = q.get("beforeSeq") ? Number(q.get("beforeSeq")) : undefined;
  const turns = listTurns(id, { limit, beforeSeq: before });
  return NextResponse.json({
    conversationId: id,
    turns: turns.map((t) => ({
      id: t.id,
      seq: t.seq,
      role: t.role,
      text: t.text,
      intakeId: t.intakeId,
      questionId: t.questionId,
      createdAt: t.createdAt,
      result: t.role === "agent" && t.intakeId ? intakeResultById(t.intakeId) : null,
    })),
    questions,
    nextBeforeSeq: turns.length === limit && turns[0] ? turns[0].seq : null,
  });
}
