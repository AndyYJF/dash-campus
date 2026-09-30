import { NextResponse } from "next/server";
import { listSessions } from "@/domain/session";
import { requireOwner } from "@/workflows/auth-guard";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({
    sessions: listSessions().map((s) => ({
      id: s.id,
      createdAt: s.createdAt ?? null,
      expiresAt: s.expiresAt,
      revokedAt: s.revokedAt,
    })),
  });
}
