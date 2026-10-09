import { NextRequest, NextResponse } from "next/server";
import { findSessionByToken, revokeSession, sessionCookieName } from "@/domain/session";

export const dynamic = "force-dynamic";

/** 撤销当前会话（幂等：无会话也返回 204） */
export async function POST(request: NextRequest) {
  const token = request.cookies.get(sessionCookieName())?.value;
  if (token) {
    const session = findSessionByToken(token);
    if (session) revokeSession(session.id);
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(sessionCookieName(), "", { httpOnly: true, path: "/", maxAge: 0 });
  return response;
}
