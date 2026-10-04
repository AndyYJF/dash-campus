import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { requireOwner } from "@/workflows/auth-guard";
import { errorResponse, runIdempotent, HttpError } from "@/workflows/http";
import { intakeCreateSchema, type IntakeCreateInput } from "@/contracts/intake";
import { receiveIntake, submitAnswer } from "@/workflows/intake";
import { listIntakes } from "@/repositories/intakes";
import { getQuestion } from "@/repositories/questions";
import { intakeResultView } from "@/workflows/results";
import { NextResponse } from "next/server";
import { saveAttachments, type IncomingFile } from "@/workflows/intake-files";

import { parseAgentText, agentInputIssue } from "@/domain/agent-input";

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
  const agentText = parseAgentText(input.text);
  const issue = agentInputIssue(agentText, { hasFiles: files.length > 0, hasUrls: input.urls.length > 0, hasTask: input.selectedEntityRef?.kind === "task", hasQuestion: Boolean(input.questionId), hasSlot: Boolean(input.slot) });
  if (issue) return errorResponse("INVALID_AGENT_INPUT", issue, 422);

  return runIdempotent(request, raw, {
    actorScope: `owner:${auth.session.ownerId}`,
    route: "v2.intakes.create",
    execute: () => {
      // 点着问题卡在统一入口回答：按那个问题的用途解析，不当成一份新材料
      if (input.questionId) {
        const q = getQuestion(input.questionId);
        if (!q || q.status !== "open") throw new HttpError(409, "QUESTION_NOT_OPEN", "该问题已回答或失效，请重新选择；这句话没有作为新任务提交");
        if (input.questionVersion !== undefined && input.questionVersion !== q.version) throw new HttpError(409, "STALE_ANSWER", "问题已更新，请按最新问题重新回答");
        if (q.status === "open") {
          const r = submitAnswer({ questionId: q.id, expectedVersion: input.questionVersion ?? q.version, text: agentText.body });
          if (r.kind === "answered") return { statusCode: 202, body: { answered: true, questionId: q.id, results: r.results, note: r.note }, resourceType: "clarification_answer", resourceId: q.id };
          if (r.kind === "unparseable") return { statusCode: 422, body: { error: { code: "ANSWER_UNPARSEABLE", message: `没看懂这个回答。${r.hint}` } }, resourceType: null, resourceId: null };
        }
      }
      const context: Record<string, unknown> = {};
      if (agentText.command) context.agentCommand = agentText.command;
      if (input.selectedEntityRef) context.selectedEntityRef = input.selectedEntityRef;
      if (input.slot) context.slot = input.slot;
      const r = receiveIntake({ channel: "web", text: input.text, referenceDate: input.referenceDate, urls: input.urls, conversationId: input.conversationId, context });
      if (files.length) saveAttachments(r.intakeId, files);
      return { statusCode: 202, body: { intakeId: r.intakeId, status: r.status, conversationId: r.conversationId }, resourceType: "intake", resourceId: r.intakeId };
    },
  });
}

/** GET /api/v2/intakes?cursor=&limit=&status= —— 服务端分页历史：换设备、刷新后仍能找到每条输入的结果 */
export async function GET(request: NextRequest) {
  const auth = requireOwner(request);
  if (!auth.ok) return auth.response;
  const q = request.nextUrl.searchParams;
  const page = listIntakes({ limit: Number(q.get("limit") ?? 10) || 10, cursor: q.get("cursor"), status: q.get("status") });
  return NextResponse.json({ intakes: page.intakes.map(intakeResultView), nextCursor: page.nextCursor });
}

type ParsedInput =
  | { ok: true; input: IntakeCreateInput; files: IncomingFile[]; raw: string }
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
  const json = (name: string): unknown => {
    try {
      return form.get(name) ? JSON.parse(String(form.get(name))) : undefined;
    } catch {
      return undefined;
    }
  };
  const fields = {
    text: String(form.get("text") ?? ""),
    referenceDate: (form.get("referenceDate") as string) || undefined,
    urls: form.getAll("urls").map(String).filter(Boolean),
    conversationId: (form.get("conversationId") as string) || undefined,
    questionId: (form.get("questionId") as string) || undefined,
    questionVersion: form.get("questionVersion") ? Number(form.get("questionVersion")) : undefined,
    selectedEntityRef: json("selectedEntityRef"),
    slot: json("slot"),
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
  // 文件按内容摘要参与比对：同名同大小但内容不同不是重试（E38）
  const digests = files.map((f) => `${f.name}:${f.bytes.length}:${crypto.createHash("sha256").update(f.bytes).digest("hex")}`);
  const raw = JSON.stringify({ text: fields.text, urls: fields.urls, referenceDate: fields.referenceDate, conversationId: fields.conversationId, questionId: fields.questionId, questionVersion: fields.questionVersion, selectedEntityRef: fields.selectedEntityRef, slot: fields.slot, files: digests });
  return { ok: true, input: parsed.data, files, raw };
}
