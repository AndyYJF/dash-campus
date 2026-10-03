import { NextResponse, type NextRequest } from "next/server";
import { ZodType } from "zod";
import { getDb } from "@/repositories/db";
import { checkIdempotency, recordIdempotency } from "@/workflows/idempotency";

/** 统一错误响应：{error:{code,message,details?}} */
export function errorResponse(
  code: string,
  message: string,
  status: number,
  details?: unknown,
): NextResponse {
  return NextResponse.json(
    { error: { code, message, ...(details !== undefined ? { details } : {}) } },
    { status },
  );
}

export const conflict409 = (message = "版本冲突，请刷新后重试") =>
  errorResponse("CONFLICT", message, 409);

export const notFound404 = (message = "资源不存在") => errorResponse("NOT_FOUND", message, 404);

/** 业务层可抛出的已知错误：在幂等事务内抛出会整体回滚，且不记录幂等键 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

/** SQLite 外键约束失败：请求里引用的 ID 不存在，按输入错误处理而不是 500 */
export function isForeignKeyViolation(e: unknown): boolean {
  return (e as { code?: string } | null)?.code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

export const invalidReference422 = () =>
  errorResponse("INVALID_REFERENCE", "引用的目标、项目、任务或其他对象不存在", 422);

/** 同步执行数据库变更；外键失败转成 422，其他错误照常抛出 */
export function withReferenceCheck(fn: () => NextResponse): NextResponse {
  try {
    return fn();
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.code, e.message, e.status, e.details);
    if (isForeignKeyViolation(e)) return invalidReference422();
    throw e;
  }
}

type IdemArgs = { actorScope: string; route: string };

/**
 * 幂等执行（计划第 9 节）：check → execute → record 在同一个 IMMEDIATE 事务里。
 * - 同键并发：第二个请求在写锁上等待，拿到锁后看到第一个的记录，重放而不是重复创建；
 * - 进程在 execute 与 record 之间崩溃：事务回滚，资源与幂等记录一起不存在，重试会重新创建一次。
 * execute 必须是同步的数据库操作（better-sqlite3 事务不能跨 await）；外部调用不能放进来。
 */
export function runIdempotent(
  request: NextRequest,
  rawBody: string,
  args: IdemArgs & {
    /** 返回 statusCode 与响应体；resourceId 用于记录 */
    execute: () => { statusCode: number; body: unknown; resourceType: string | null; resourceId: string | null };
  },
): NextResponse {
  const key = request.headers.get("idempotency-key");
  if (!key) {
    return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "创建请求必须携带 Idempotency-Key 头", 422);
  }
  const scope = { actorScope: args.actorScope, route: args.route, key, requestBody: rawBody };
  const db = getDb();
  const tx = db.transaction((): NextResponse => {
    const existing = checkIdempotency(scope);
    if (existing.kind === "collision") {
      return errorResponse("IDEMPOTENCY_COLLISION", "相同 Idempotency-Key 携带了不同的请求体", 409);
    }
    if (existing.kind === "replay") return NextResponse.json(existing.body, { status: existing.statusCode });
    const r = args.execute();
    recordIdempotency({ ...scope, statusCode: r.statusCode, resourceType: r.resourceType, resourceId: r.resourceId, responseBody: r.body });
    return NextResponse.json(r.body, { status: r.statusCode });
  });
  try {
    return tx.immediate();
  } catch (e) {
    if (e instanceof HttpError) return errorResponse(e.code, e.message, e.status, e.details);
    if (isForeignKeyViolation(e)) return invalidReference422();
    throw e;
  }
}

export function parseJson(raw: string): { ok: true; value: unknown } | { ok: false; response: NextResponse } {
  try {
    return { ok: true, value: raw ? JSON.parse(raw) : null };
  } catch {
    return { ok: false, response: errorResponse("VALIDATION", "请求体不是合法 JSON", 422) };
  }
}

/**
 * 创建型 POST 的统一流程：Idempotency-Key 必填 → Zod 校验 → 在幂等事务里创建并记录。
 * 校验失败不记录幂等键（修正后可用同一键重发）。
 */
export async function handleIdempotentCreate<T>(
  request: NextRequest,
  args: IdemArgs & {
    schema: ZodType<T>;
    resourceType: string;
    execute: (input: T) => { id: string };
  },
): Promise<NextResponse> {
  const rawBody = await request.text();
  if (!request.headers.get("idempotency-key")) {
    return errorResponse("IDEMPOTENCY_KEY_REQUIRED", "创建请求必须携带 Idempotency-Key 头", 422);
  }
  const json = parseJson(rawBody);
  if (!json.ok) return json.response;
  const parsed = args.schema.safeParse(json.value);
  if (!parsed.success) {
    return errorResponse("VALIDATION", "输入不合法", 422, parsed.error.issues);
  }
  return runIdempotent(request, rawBody, {
    actorScope: args.actorScope,
    route: args.route,
    execute: () => {
      const resource = args.execute(parsed.data);
      return { statusCode: 201, body: { id: resource.id }, resourceType: args.resourceType, resourceId: resource.id };
    },
  });
}
