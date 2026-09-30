import { NextResponse, type NextRequest } from "next/server";
import { findSessionByToken, SESSION_COOKIE, type SessionRecord } from "@/domain/session";

/**
 * 登录守卫与 CSRF。
 * requireOwner: 未登录返回 401；变更请求必须带匹配的 x-csrf-token。
 */

export type AuthResult =
  | { ok: true; session: SessionRecord }
  | { ok: false; response: NextResponse };

export function requireOwner(request: NextRequest): AuthResult {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return { ok: false, response: unauthorized("未登录") };
  }
  const session = findSessionByToken(token);
  if (!session) {
    return { ok: false, response: unauthorized("会话无效或已过期") };
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const csrfHeader = request.headers.get("x-csrf-token");
    if (!csrfHeader || csrfHeader !== session.csrfToken) {
      return {
        ok: false,
        response: NextResponse.json(
          { error: { code: "CSRF_INVALID", message: "CSRF 校验失败" } },
          { status: 403 },
        ),
      };
    }
  }
  return { ok: true, session };
}

function unauthorized(message: string): NextResponse {
  return NextResponse.json({ error: { code: "UNAUTHORIZED", message } }, { status: 401 });
}
