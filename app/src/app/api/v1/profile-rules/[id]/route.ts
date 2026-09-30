import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { PARTITIONS } from "@/contracts/inbox";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, notFound404 } from "@/workflows/http";
import { deleteRule, getRule, updateRule } from "@/repositories/profile";
import { reevaluateAllCurrent } from "@/workflows/inbox";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    enabled: z.boolean().optional(),
    priority: z.number().int().min(1).max(100).optional(),
    outputPartition: z.enum(PARTITIONS).optional(),
  })
  .extend({ expectedVersion: z.number().int().min(1) });

/** GET /api/v1/profile-rules/:id */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const rule = getRule(id);
  if (!rule) return notFound404("规则不存在");
  return NextResponse.json({ rule });
}

/**
 * PATCH /api/v1/profile-rules/:id —— 启用/停用/调整。
 * 变更后只标待重评：立即重评所有当前修订（不回写已确认任务）。
 */
export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return conflict409();
  const { expectedVersion, ...patch } = parsed.data;
  const result = updateRule(id, patch, expectedVersion);
  if (result === "not_found") return notFound404("规则不存在");
  if (result === "conflict") return conflict409();
  reevaluateAllCurrent();
  return NextResponse.json({ rule: result });
}

/** DELETE /api/v1/profile-rules/:id —— 可撤销；删除后重评 */
export async function DELETE(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const ok = deleteRule(id);
  if (!ok) return notFound404("规则不存在");
  reevaluateAllCurrent();
  return NextResponse.json({ deleted: id });
}
