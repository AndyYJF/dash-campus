import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { notFound404 } from "@/workflows/http";
import { deleteExport, getExport } from "@/workflows/exports";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const e = getExport(id);
  if (!e || e.status === "deleted") return notFound404("导出不存在");
  const expired = e.status === "expired" || e.expiresAt <= new Date().toISOString();
  return NextResponse.json({ export: { ...e, status: expired && e.status === "ready" ? "expired" : e.status } });
}

/** DELETE —— 删除导出文件与记录（软删除记录，文件立即删除） */
export async function DELETE(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  if (!deleteExport(id)) return notFound404("导出不存在");
  return NextResponse.json({ ok: true });
}
