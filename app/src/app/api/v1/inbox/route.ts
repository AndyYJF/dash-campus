import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { getDecisionByRevision, getRevision, listMessages } from "@/repositories/inbox";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  partition: z.string().optional(),
  status: z.string().optional(),
});

/** GET /api/v1/inbox —— 逻辑消息列表（含当前修订决策摘要） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) return errorResponse("VALIDATION", "查询参数不合法", 422);

  const items = listMessages({ status: q.data.status })
    .map((m) => {
      const revision = m.currentRevisionId ? getRevision(m.currentRevisionId) : null;
      const decision = m.currentRevisionId ? getDecisionByRevision(m.currentRevisionId) : null;
      if (q.data.partition && decision?.partition !== q.data.partition) return null;
      return {
        id: m.id,
        sourceId: m.sourceId,
        externalId: m.externalId,
        status: m.status,
        partition: decision?.partition ?? null,
        applicability: decision?.applicability ?? null,
        noticeType: revision?.structured?.noticeType ?? null,
        title: revision?.structured?.action?.title ?? (revision ? revision.text.slice(0, 80) : ""),
        occurredAt: revision?.occurredAt ?? null,
        textPreview: revision ? revision.text.slice(0, 200) : "",
        updatedAt: m.updatedAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return NextResponse.json({ items });
}
