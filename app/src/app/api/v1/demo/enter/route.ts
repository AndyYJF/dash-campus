import { NextResponse, type NextRequest } from "next/server";
import { createSession, findSessionByToken, sessionCookieName } from "@/domain/session";
import { DEMO_LIMITS, DEMO_SESSION_TTL_MS, demoRateHit, isDemoMode } from "@/domain/demo";
import { clientKey } from "@/domain/login-limit";
import { errorResponse } from "@/workflows/http";
import { readDemoMarker } from "@/workflows/demo";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/demo/enter —— 领一个访客会话（只在演示实例上存在，不需要密码）。
 * 已有有效访客会话时直接沿用，只把 CSRF 令牌再发一次；否则新建一个一天有效的会话。
 * 返回体与登录接口相同，前端后续流程不区分。
 */
export function POST(request: NextRequest) {
  if (!isDemoMode()) return errorResponse("NOT_FOUND", "这个实例没有开启演示模式", 404);

  // 第二道保险：启动检查之外，这里也只给带演示标记的库发访客会话
  if (!readDemoMarker()) return errorResponse("INTEGRATION_UNAVAILABLE", "演示数据还没有准备好", 503);

  const existing = request.cookies.get(sessionCookieName())?.value;
  const current = existing ? findSessionByToken(existing) : null;
  if (current) {
    return NextResponse.json({ sessionId: current.id, csrfToken: current.csrfToken, expiresAt: current.expiresAt });
  }

  const wait = demoRateHit(`enter:${clientKey(request.headers)}`, DEMO_LIMITS.enterPerClient);
  if (wait !== null) {
    return NextResponse.json(
      { error: { code: "RATE_LIMITED", message: `进入演示太频繁，请 ${Math.ceil(wait / 60)} 分钟后再试` } },
      { status: 429, headers: { "Retry-After": String(wait) } },
    );
  }
  const { session, token } = createSession(1, DEMO_SESSION_TTL_MS);
  const response = NextResponse.json({ sessionId: session.id, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
  response.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return response;
}
