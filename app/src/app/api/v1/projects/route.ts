import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { projectSchema } from "@/contracts/planning";
import { createProject, listProjects } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { handleIdempotentCreate } from "@/workflows/http";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ projects: listProjects() });
}

export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return handleIdempotentCreate(request, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "projects",
    schema: projectSchema,
    resourceType: "project",
    execute: (input) => createProject(input),
  });
}
