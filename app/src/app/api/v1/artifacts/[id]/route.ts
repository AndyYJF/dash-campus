import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { archiveArtifact } from "@/repositories/logs";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** DELETE /api/v1/artifacts/:id —— 软删除，要求 expectedVersion */
export async function DELETE(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = z
    .object({ expectedVersion: z.number().int().min(1) })
    .safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const result = archiveArtifact(id, parsed.data.expectedVersion);
  if (result === "not_found") return notFound404("成果不存在或已删除");
  if (result === "conflict") return conflict409();
  return NextResponse.json({ artifact: result });
}
