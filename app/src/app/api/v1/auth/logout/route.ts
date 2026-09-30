import { NextRequest, NextResponse } from "next/server";
import { findSessionByToken, revokeSession, SESSION_COOKIE } from "@/domain/session";

export const dynamic = "force-dynamic";

/** 撤销当前会话（幂等：无会话也返回 204） */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    const session = findSessionByToken(token);
    if (session) revokeSession(session.id);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
