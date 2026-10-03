import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { getLegacyReceipt } from "@/workflows/legacy";
import { notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const { id } = await context.params;
  if (!/^[a-f0-9-]{36}$/i.test(id)) return notFound404("导入结果不存在");
  const receipt = getLegacyReceipt(id); if (!receipt) return notFound404("导入结果不存在");
  return new NextResponse(JSON.stringify(receipt, null, 2) + "\n", { headers: {
    "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="todo-import-${receipt.id}.json"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
}
