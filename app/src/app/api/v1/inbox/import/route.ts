import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { noticeImportSchema } from "@/contracts/inbox";
import { importNotice } from "@/workflows/inbox";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/inbox/import —— 导入 envelope（计划 5.1）。
 * 鉴权：Bearer 导入 token，只能向配置允许的 source 写入；不使用浏览器会话。
 * 重复（同 revisionKey 同正文）返回既有资源；异正文 409 SOURCE_REVISION_COLLISION。
 * 去重以 revision 为准（强于 Idempotency-Key），故不要求该头。
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.get("authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "导入需要 Bearer token" } },
      { status: 401 },
    );
  }
  const parsed = noticeImportSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: "输入不合法", details: parsed.error.issues } },
      { status: 422 },
    );
  }
  const result = importNotice(parsed.data, token);
  if (!result.ok) {
    if (result.error === "source_forbidden") {
      return NextResponse.json(
        { error: { code: "SOURCE_FORBIDDEN", message: "来源不存在或 token 不匹配" } },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: { code: "SOURCE_REVISION_COLLISION", message: "相同 revisionKey 携带了不同正文" } },
      { status: 409 },
    );
  }
  const status = result.kind === "created" ? 201 : 200;
  return NextResponse.json(
    {
      kind: result.kind,
      messageId: result.messageId,
      revisionId: result.revisionId,
      ...("becameCurrent" in result ? { becameCurrent: result.becameCurrent } : {}),
    },
    { status },
  );
}
