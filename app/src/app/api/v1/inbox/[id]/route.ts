import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";
import {
  getDecisionByRevision,
  getMessage,
  getRevision,
  listRevisions,
  listTaskLinks,
} from "@/repositories/inbox";
import { getTask } from "@/repositories/planning";
import { extractionFor } from "@/workflows/notice-extraction";
import { sourceChangeDiff } from "@/workflows/inbox";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET /api/v1/inbox/:id —— 详情：修订历史、决策与条件引用、任务关联与来源变化差异 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const message = getMessage(id);
  if (!message) return notFound404("通知不存在");

  const current = message.currentRevisionId ? getRevision(message.currentRevisionId) : null;
  const decision = message.currentRevisionId ? getDecisionByRevision(message.currentRevisionId) : null;
  const revisions = listRevisions(id).map((r) => ({
    id: r.id,
    revisionKey: r.revisionKey,
    revisionOrder: r.revisionOrder,
    occurredAt: r.occurredAt,
    isCurrent: r.id === message.currentRevisionId,
    createdAt: r.createdAt,
  }));

  return NextResponse.json({
    message,
    current: current
      ? {
          id: current.id,
          text: current.text,
          sourceUrl: current.sourceUrl,
          structured: current.structured,
          occurredAt: current.occurredAt,
        }
      : null,
    decision,
    extraction: current ? extractionFor(current.id) : null,
    revisions,
    links: listTaskLinks(id).map((l) => ({ ...l, task: getTask(l.taskId) })),
    sourceChanges: sourceChangeDiff(id),
  });
}
