import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { PARTITIONS, profileRuleSchema } from "@/contracts/inbox";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, notFound404 } from "@/workflows/http";
import {
  resolveProfile,
  resolveRule,
  resolveThisRevision,
} from "@/workflows/inbox";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** 纠正三作用域（计划 5.2），默认仅本条 */
const resolveSchema = z.discriminatedUnion("scope", [
  z.object({
    scope: z.literal("this_revision"),
    partition: z.enum(PARTITIONS),
    revisionId: z.string().uuid(),
    expectedVersion: z.number().int().min(1),
  }),
  z.object({
    scope: z.literal("profile"),
    facts: z
      .array(
        z.object({
          field: z.string().min(1).max(50),
          value: z.string().trim().min(1).max(200),
          expectedVersion: z.number().int().min(0),
        }),
      )
      .min(1),
  }),
  z.object({
    scope: z.literal("rule"),
    rule: profileRuleSchema,
  }),
]);

/** POST /api/v1/inbox/:id/resolve —— 必填作用域 this_revision / profile / rule */
export async function POST(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const parsed = resolveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  }

  switch (parsed.data.scope) {
    case "this_revision": {
      const r = resolveThisRevision(id, parsed.data.partition, parsed.data.revisionId, parsed.data.expectedVersion);
      if (r === 'conflict') return errorResponse('CONFLICT', '通知已更新，请查看新版本后再纠正', 409);
      if (r === "not_found") return notFound404("通知或当前修订不存在");
      return NextResponse.json({ resolved: "this_revision" });
    }
    case "profile": {
      const r = resolveProfile(parsed.data.facts);
      if (r === "invalid_field") {
        return errorResponse("VALIDATION", "包含不允许的身份字段", 422);
      }
      return NextResponse.json({ resolved: "profile", ...r });
    }
    case "rule": {
      const rule = resolveRule(parsed.data.rule);
      return NextResponse.json({ resolved: "rule", rule });
    }
  }
}
