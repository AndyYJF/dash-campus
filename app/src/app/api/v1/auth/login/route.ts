import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/domain/password";
import { createSession, getOwnerPasswordHash, sessionCookieName } from "@/domain/session";
import { isDemoMode } from "@/domain/demo";
import { clearLoginFailures, clientKey, loginBlockedFor, recordLoginFailure } from "@/domain/login-limit";

export const dynamic = "force-dynamic";

const loginSchema = z.object({ password: z.string().min(1) });

export async function POST(request: NextRequest) {
  // 演示实例没有可用的密码，访客从 /api/v1/demo/enter 领会话
  if (isDemoMode()) {
    return NextResponse.json({ error: { code: "DEMO_DISABLED", message: "演示模式不需要密码，直接进入即可" } }, { status: 403 });
  }
  const storedHash = getOwnerPasswordHash();
  if (!storedHash) {
    return NextResponse.json(
      { error: { code: "NOT_SET_UP", message: "实例尚未初始化" } },
      { status: 403 },
    );
  }
  const client = clientKey(request.headers);
  const retryAfter = loginBlockedFor(client);
  if (retryAfter !== null) {
    return NextResponse.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: `密码错误次数过多，请 ${Math.ceil(retryAfter / 60)} 分钟后再试`,
        },
      },
      { status: 429, headers: { "Retry-After": String(retryAfter) } },
    );
  }
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !verifyPassword(parsed.data.password, storedHash)) {
    recordLoginFailure(client);
    return NextResponse.json(
      { error: { code: "INVALID_CREDENTIALS", message: "密码不正确" } },
      { status: 401 },
    );
  }
  clearLoginFailures(client);
  const { session, token } = createSession(1);
  const response = NextResponse.json(
    { sessionId: session.id, csrfToken: session.csrfToken, expiresAt: session.expiresAt },
    { status: 200 },
  );
  response.cookies.set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return response;
}
