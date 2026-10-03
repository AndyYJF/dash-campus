import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { directionSnapshot } from "@/workflows/snapshot";

export const dynamic = "force-dynamic";

/** GET /api/v2/direction（MASTER-PLAN §8）：目标/实践/证据状态，不做副作用、不编造概率。 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return Response.json(directionSnapshot(new Date()));
}
