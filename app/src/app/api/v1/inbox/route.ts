import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { getDecisionByRevision, getRevision, listMessagePage } from "@/repositories/inbox";
import { PARTITIONS } from "@/contracts/inbox";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  partition: z.enum(PARTITIONS).optional(),
  status: z.enum(["active", "revision_conflict"]).optional(),
  cursor: z.string().max(1000).optional(),
});
const cursorSchema = z.object({ updatedAt: z.iso.datetime({ offset: true }), id: z.uuid() });

/** GET /api/v1/inbox —— 逻辑消息列表（含当前修订决策摘要） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!q.success) return errorResponse("VALIDATION", "查询参数不合法", 422);

  let cursor: z.infer<typeof cursorSchema> | undefined;
  if (q.data.cursor) {
    try { cursor = cursorSchema.parse(JSON.parse(Buffer.from(q.data.cursor, "base64url").toString("utf8"))); }
    catch { return errorResponse("VALIDATION", "通知分页游标无效", 422); }
  }
  const page = listMessagePage({ status: q.data.status, partition: q.data.partition, cursor });
  const items = page.messages
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
        title: revision?.structured?.action?.title ?? revision?.legacyTitle ?? (revision ? revision.text.slice(0, 80) : ""),
        legacyStatus: revision?.legacyStatus ?? null,
        occurredAt: revision?.occurredAt ?? null,
        textPreview: revision ? revision.text.slice(0, 200) : "",
        updatedAt: m.updatedAt,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return NextResponse.json({ items, total: page.total, nextCursor: page.next ? Buffer.from(JSON.stringify(page.next)).toString("base64url") : null });
}
