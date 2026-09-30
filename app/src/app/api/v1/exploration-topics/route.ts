import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { topicCreateSchema } from "@/contracts/exploration";
import { listTopics } from "@/repositories/exploration";
import { requireOwner } from "@/workflows/auth-guard";
import { handleIdempotentCreate } from "@/workflows/http";
import { createTopic } from "@/workflows/topics";

export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return NextResponse.json({ topics: listTopics() });
}

export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return handleIdempotentCreate(request, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "exploration-topics",
    schema: topicCreateSchema,
    resourceType: "exploration_topic",
    execute: (input) => createTopic(input),
  });
}
