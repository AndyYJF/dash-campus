import { NextResponse } from "next/server";
import { listSessions } from "@/domain/session";
import { requireOwner } from "@/workflows/auth-guard";
import type { NextRequest } from "next/server";
import { isDemoMode } from "@/domain/demo";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    // 演示实例：只列自己这一个访客会话，不暴露别的访客
    sessions: listSessions().filter((s) => !isDemoMode() || s.id === auth.session.id).map((s) => ({
      id: s.id,
      createdAt: s.createdAt ?? null,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
    })),
  });
}
