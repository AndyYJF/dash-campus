import { NextResponse, type NextRequest } from "next/server";
import { revokeSession } from "@/domain/session";
import { requireOwner } from "@/workflows/auth-guard";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** 撤销指定会话（主人本人操作） */
export async function DELETE(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const ok = revokeSession(id);
  if (!ok) {
    return NextResponse.json(
      { error: { code: "NOT_FOUND", message: "会话不存在或已撤销" } },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
