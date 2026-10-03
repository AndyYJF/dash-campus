import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, runIdempotent } from "@/workflows/http";
import { intakeCreateSchema } from "@/contracts/intake";
import { receiveIntake } from "@/workflows/intake";
import { saveAttachments, type IncomingFile } from "@/workflows/intake-files";

export const dynamic = "force-dynamic";

/**
 * POST /api/v2/intakes（MASTER-PLAN §8）：JSON 或 multipart（text/urls/attachments/referenceDate）。
 * 幂等持久接收 → 202 立即返回；处理异步进行。文件字节在事务外读出，校验/落库在事务内。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;

  const isMultipart = (request.headers.get("content-type") ?? "").includes("multipart/form-data");
  const parsed = isMultipart ? await parseMultipart(request) : await parseJsonBody(request);
  if (!parsed.ok) return parsed.response;
  const { input, files, raw } = parsed;

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.intakes.create",
    execute: () => {
      const r = receiveIntake({ channel: "web", text: input.text, referenceDate: input.referenceDate, urls: input.urls });
      if (files.length) saveAttachments(r.intakeId, files);
      return { statusCode: 202, body: { intakeId: r.intakeId, status: r.status }, resourceType: "intake", resourceId: r.intakeId };
    },
  });
}

type ParsedInput =
  | { ok: true; input: { text: string; referenceDate?: string; urls: string[] }; files: IncomingFile[]; raw: string }
  | { ok: false; response: ReturnType<typeof errorResponse> };

async function parseJsonBody(request: NextRequest): Promise<ParsedInput> {
  const raw = await request.text();
  let value: unknown;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    return { ok: false, response: errorResponse("VALIDATION", "请求体不是合法 JSON", 422) };
  }
  const parsed = intakeCreateSchema.safeParse(value);
  if (!parsed.success) return { ok: false, response: errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422) };
  if (!parsed.data.text && !parsed.data.urls.length) {
    return { ok: false, response: errorResponse("VALIDATION", "内容不能为空", 422) };
  }
  return { ok: true, input: parsed.data, files: [], raw };
}

async function parseMultipart(request: NextRequest): Promise<ParsedInput> {
  const form = await request.formData().catch(() => null);
  if (!form) return { ok: false, response: errorResponse("VALIDATION", "multipart 解析失败", 422) };
  const fields = {
    text: String(form.get("text") ?? ""),
    referenceDate: (form.get("referenceDate") as string) || undefined,
    urls: form.getAll("urls").map(String).filter(Boolean),
  };
  const parsed = intakeCreateSchema.safeParse(fields);
  if (!parsed.success) return { ok: false, response: errorResponse("VALIDATION", parsed.error.issues.map((i) => i.message).join("；"), 422) };
  const rawFiles = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!parsed.data.text && !parsed.data.urls.length && !rawFiles.length) {
    return { ok: false, response: errorResponse("VALIDATION", "内容不能为空", 422) };
  }
  const files: IncomingFile[] = [];
  for (const f of rawFiles) files.push({ name: f.name, mediaType: f.type, bytes: new Uint8Array(await f.arrayBuffer()) });
  // 幂等键去重按规范化摘要：multipart 原始字节含随机 boundary，不能直接做请求体比对
  const raw = JSON.stringify({ text: fields.text, urls: fields.urls, referenceDate: fields.referenceDate, files: rawFiles.map((f) => `${f.name}:${f.size}`) });
  return { ok: true, input: parsed.data, files, raw };
}
