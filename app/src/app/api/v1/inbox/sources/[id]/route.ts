import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { getDb } from "@/repositories/db";
import { getSource } from "@/repositories/inbox";
import { errorResponse, conflict409, notFound404 } from "@/workflows/http";
export const dynamic = "force-dynamic";
export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const p = z.object({ title: z.string().trim().min(1).max(200), enabled: z.boolean(), expectedVersion: z.number().int().min(1) }).safeParse(await request.json().catch(() => null));
  if (!p.success) return errorResponse("VALIDATION", "来源设置不合法", 422);
  if (!getSource(id)) return notFound404("来源不存在");
  if (id === "manual" && !p.data.enabled) return errorResponse("VALIDATION", "手工录入来源不可停用", 422);
  const changes = getDb().prepare("UPDATE inbox_sources SET title=?,enabled=?,version=version+1,updated_at=? WHERE id=? AND version=?").run(p.data.title, p.data.enabled ? 1 : 0, new Date().toISOString(), id, p.data.expectedVersion).changes;
  if (!changes) return conflict409(); return NextResponse.json({ source: getSource(id) });
}
