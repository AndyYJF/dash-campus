import { NextResponse, type NextRequest } from "next/server";
import { findSessionByToken, sessionCookieName, type SessionRecord } from "@/domain/session";
import { sameSecret } from "@/domain/secrets";
import { demoBlockedReason, demoWriteLimited, isDemoMode } from "@/domain/demo";
import { clientKey } from "@/domain/login-limit";

/**
 * 登录守卫与 CSRF。
 * requireOwner: 未登录返回 401；变更请求必须带匹配的 x-csrf-token。
 * 演示实例上会话是访客领的（不输密码），其余校验相同；另外按 domain/demo.ts 关掉对外入口并给写入限速。
 */

export type AuthResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; response: NextResponse };

export function requireOwner(request: NextRequest): AuthResult {
  const demo = isDemoMode();
  if (demo) {
    const blocked = demoBlockedReason(request.method, request.nextUrl.pathname);
    if (blocked) {
      return { ok: false, response: NextResponse.json({ error: { code: "DEMO_DISABLED", message: blocked } }, { status: 403 }) };
    }
  }
  const token = request.cookies.get(sessionCookieName())?.value;
  if (!token) {
    return { ok: false, response: unauthorized("未登录") };
  }
  const session = findSessionByToken(token);
  if (!session) {
    return { ok: false, response: unauthorized("会话无效或已过期") };
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const csrfHeader = request.headers.get("x-csrf-token");
    if (!csrfHeader || !sameSecret(csrfHeader, session.csrfToken)) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: { code: "CSRF_INVALID", message: "CSRF 校验失败" } },
          { status: 403 },
        ),
      };
    }
    if (demo) {
      const wait = demoWriteLimited({ sessionId: session.id, client: clientKey(request.headers), pathname: request.nextUrl.pathname });
      if (wait !== null) {
        return {
          ok: false,
          response: NextResponse.json(
            { error: { code: "RATE_LIMITED", message: `演示环境操作太频繁，请 ${Math.ceil(wait / 60)} 分钟后再试` } },
            { status: 429, headers: { "Retry-After": String(wait) } },
          ),
        };
      }
    }
  }
  return { ok: true, session };
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: { code: "UNAUTHORIZED", message } }, { status: 401 });
}
