import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireOwner } from "@/workflows/auth-guard";
import { taskSchema } from "@/contracts/planning";
import { handleIdempotentCreate } from "@/workflows/http";
import { startTemplate } from "@/workflows/templates";
export const dynamic = "force-dynamic";
export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const { id } = await ctx.params;
  return handleIdempotentCreate(request, { actorScope: `owner:${auth.session.ownerId}`, route: `template.start:${id}`, schema: z.object({ expectedVersion: z.number().int().min(1), plannedWeek: taskSchema.shape.plannedWeek }), resourceType: "project", execute: (input) => startTemplate(id, input.expectedVersion, input.plannedWeek) });
}
