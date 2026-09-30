import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { listDeliveries, type DeliveryStatus } from "@/repositories/deliveries";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";

export const dynamic = "force-dynamic";

const statuses = [
  "queued",
  "submitting",
  "accepted",
  "failed",
  "unknown",
  "cancelled",
] as const;

const querySchema = z.object({
  status: z.enum(statuses).optional(),
  taskId: z.string().uuid().optional(),
});

/** 去掉大字段后的投递摘要（不泄露正文快照与内部租约 token） */
function publicDelivery<T extends Record<string, unknown>>(d: T): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...d };
  delete copy.snapshot;
  delete copy.leaseToken;
  return copy;
}

/** GET /api/v1/deliveries —— 按状态查询投递记录；accepted 只代表发送服务接受 */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return errorResponse("VALIDATION", "查询参数不合法", 422);
  const rows = listDeliveries(parsed.data).map(publicDelivery);
  return NextResponse.json({ deliveries: rows });
}

export type { DeliveryStatus };
