import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createArtifact, listArtifacts } from "@/repositories/logs";
import { getProject } from "@/repositories/planning";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, HttpError, parseJson, runIdempotent } from "@/workflows/http";

export const dynamic = "force-dynamic";

const artifactSchema = z.object({
  projectId: z.string().uuid(),
  logId: z.string().uuid().nullable().optional(),
  kind: z.enum(["text", "link"]),
  title: z.string().trim().min(1).max(200),
  body: z.string().max(10000).default(""),
  url: z.string().nullable().optional(),
});

export function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return errorResponse("VALIDATION", "缺少 projectId", 422);
  return NextResponse.json({ artifacts: listArtifacts(projectId) });
}

/** POST —— 创建要求 Idempotency-Key（第 9 节）；关联项目由服务端校验 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const rawBody = await request.text();
  const json = parseJson(rawBody);
  if (!json.ok) return json.response;
  const parsed = artifactSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  return runIdempotent(request, rawBody, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "artifacts",
    execute: () => {
      const project = getProject(parsed.data.projectId);
      if (!project || project.archivedAt) throw new HttpError(422, "VALIDATION", "项目不存在或已归档");
      const result = createArtifact({ ...parsed.data, logId: parsed.data.logId ?? null, url: parsed.data.url ?? null });
      if (result === "invalid_url") throw new HttpError(422, "VALIDATION", "URL 只允许 http/https");
      return { statusCode: 201, body: { artifact: result }, resourceType: "artifact", resourceId: result.id };
    },
  });
}
