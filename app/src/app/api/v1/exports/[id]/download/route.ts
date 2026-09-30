import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { readExportFile } from "@/workflows/exports";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/** GET 鉴权下载（F18）：未登录 401，过期 410；只读已生成的文件，不重新生成 */
export async function GET(request: NextRequest, ctx: Params) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  const r = readExportFile(id);
  if (!r.ok) return errorResponse(r.code, r.message, r.status);
  return new Response(new Uint8Array(r.body), {
    status: 200,
    headers: {
      "content-type": r.contentType,
      "content-disposition": `attachment; filename="${r.fileName}"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
