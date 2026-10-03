import { NextResponse, type NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { listLegacyReceipts, listLegacyInstances, serverLegacySnapshot } from "@/workflows/legacy";
import { listSources } from "@/repositories/inbox";
import { withReferenceCheck } from "@/workflows/http";

export const dynamic = "force-dynamic";
export function GET(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  return withReferenceCheck(() => NextResponse.json(request.nextUrl.searchParams.get("server") === "1"
    ? { snapshot: serverLegacySnapshot() }
    : { receipts: listLegacyReceipts(), instances: listLegacyInstances(), sources: listSources().map((s) => ({ id: s.id, title: s.title })) }));
}
