import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { listTemplates } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ templates: listTemplates() });
}
