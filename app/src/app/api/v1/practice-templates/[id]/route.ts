import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getTemplate, updateTemplateRow } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { conflict409, errorResponse, notFound404 } from "@/workflows/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const list = z.array(z.string().trim().min(1).max(300)).max(10);

const patchSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(["draft", "ready"]).optional(),
  question: z.string().trim().min(1).max(500).optional(),
  activities: list.optional(),
  prerequisites: list.optional(),
  requiredResources: list.optional(),
  deliverables: list.optional(),
  firstStep: z.string().max(500).optional(),
  reviewQuestions: list.optional(),
  sourceLinks: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(200),
        url: z.string().url().refine((u) => /^https?:\/\//.test(u), "仅限 http/https"),
        license: z.string().trim().max(200),
      }),
    )
    .max(10)
    .optional(),
});

export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const t = getTemplate(id);
  if (!t) return notFound404("模板不存在");
  return NextResponse.json({ template: t });
}

/**
 * PATCH：主人编辑模板。改为 ready 必须至少有一个来源链接且每个都写明许可（7.1：核实来源与许可后才可 ready）。
 */
export async function PATCH(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  const current = getTemplate(id);
  if (!current) return notFound404("模板不存在");
  const { expectedVersion, ...fields } = parsed.data;
  const links = fields.sourceLinks ?? current.sourceLinks;
  if ((fields.status ?? current.status) === "ready" && (links.length === 0 || links.some((l) => !l.license.trim()))) {
    return errorResponse("TEMPLATE_NOT_VERIFIED", "标记为 ready 前需要填写具体来源链接并注明许可", 422);
  }
  const updated = updateTemplateRow(id, expectedVersion, fields);
  if (!updated) return conflict409();
  return NextResponse.json({ template: updated });
}
