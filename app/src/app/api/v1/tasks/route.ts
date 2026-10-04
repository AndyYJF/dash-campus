import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { taskCreateSchema } from "@/contracts/planning";
import { createTask, listTasks } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { handleIdempotentCreate } from "@/workflows/http";
import { journaledTaskWrite } from "@/workflows/compat";

export const dynamic = "force-dynamic";

const listQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
});

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const query = listQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!query.success) {
    return NextResponse.json({ error: { code: "VALIDATION", message: "查询参数不合法" } }, { status: 422 });
  }
  return NextResponse.json({ tasks: listTasks({ projectId: query.data.projectId }) });
}

export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  return handleIdempotentCreate(request, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "tasks",
    schema: taskCreateSchema,
    resourceType: "task",
    // 与统一操作同一份变更记录：最近变化里可见、可撤销
    execute: (input) => journaledTaskWrite(null, () => createTask(input), (t) => t.id),
  });
}
