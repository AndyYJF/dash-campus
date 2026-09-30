import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { getProposal } from "@/repositories/proposals";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const proposal = getProposal(id);
  if (!proposal) return errorResponse("NOT_FOUND", "提案不存在", 404);
  return NextResponse.json({ proposal });
}
