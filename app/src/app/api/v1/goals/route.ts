import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { goalSchema } from "@/contracts/planning";
import { createGoal, listGoals } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { handleIdempotentCreate } from "@/workflows/http";
import { journaledWrite } from "@/workflows/compat";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ goals: listGoals() });
}

export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return handleIdempotentCreate(request, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "goals",
    schema: goalSchema,
    resourceType: "goal",
    execute: (input) => journaledWrite("goal", null, () => createGoal(input), (g) => g.id),
  });
}
