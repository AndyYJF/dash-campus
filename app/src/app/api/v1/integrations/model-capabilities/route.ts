import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse } from "@/workflows/http";
import { modelCapabilitiesView, runModelCapabilityProbe } from "@/workflows/model-capabilities";

export const dynamic = "force-dynamic";

/** GET —— 已保存的端点能力（supported/unsupported/unknown）；配置变化后标 stale。不含 key */
export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ view: modelCapabilitiesView() });
}

/** POST —— 主人手动重探：发出约 5 次真实请求并计入今日模型额度 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const r = await runModelCapabilityProbe();
  if (!r.ok) return errorResponse(r.code, r.message, r.code === "RESTORED_HOLD" ? 409 : 503);
  return NextResponse.json({ view: modelCapabilitiesView() });
}
