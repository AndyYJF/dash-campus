import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyPassword } from "@/domain/password";
import { createSession, getOwnerPasswordHash, SESSION_COOKIE } from "@/domain/session";

export const dynamic = "force-dynamic";

const loginSchema = z.object({ password: z.string().min(1) });

export async function POST(request: NextRequest) {
  const storedHash = getOwnerPasswordHash();
  if (!storedHash) {
    return NextResponse.json(
      { error: { code: "NOT_SET_UP", message: "实例尚未初始化" } },
      { status: 403 },
    );
  }
  const parsed = loginSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success || !verifyPassword(parsed.data.password, storedHash)) {
    return NextResponse.json(
      { error: { code: "INVALID_CREDENTIALS", message: "密码不正确" } },
      { status: 401 },
    );
  }
  const { session, token } = createSession(1);
  const response = NextResponse.json(
    { sessionId: session.id, csrfToken: session.csrfToken, expiresAt: session.expiresAt },
    { status: 200 },
  );
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  return response;
}
