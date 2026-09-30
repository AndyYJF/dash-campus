import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { createSource, listSources } from "@/repositories/inbox";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,50}$/),
  title: z.string().max(200).default(""),
});

/** GET /api/v1/inbox/sources —— 来源列表（不含 token 摘要） */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ sources: listSources() });
}

/**
 * POST /api/v1/inbox/sources —— 创建持久来源标识 + 导入 token。
 * token 明文仅在响应中出现一次（存 sha256 摘要）。来源标识不能随插件重启更换。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  try {
    const { source, token } = createSource(parsed.data.id, parsed.data.title);
    return NextResponse.json({ source, token }, { status: 201 });
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE") {
      return errorResponse("SOURCE_EXISTS", "来源标识已存在（持久标识不可更换）", 409);
    }
    throw e;
  }
}
