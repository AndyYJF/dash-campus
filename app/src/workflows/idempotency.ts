import crypto from "node:crypto";
import { getDb } from "@/repositories/db";

/**
 * 幂等键：创建 POST 要求 Idempotency-Key 头（会话操作除外）。
 * (actor_scope, route, key) 唯一；同键同请求体重放返回既有结果；同键不同体 409。
 */

export type IdempotencyOutcome =
  | { kind: "execute" }
  | { kind: "replay"; statusCode: number; body: unknown }
  | { kind: "collision" };

export function checkIdempotency(args: {
  actorScope: string;
  route: string;
  key: string;
  requestBody: string;
}): IdempotencyOutcome {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT request_hash, status_code, response_body FROM idempotency_keys
       WHERE actor_scope = ? AND route = ? AND key = ?`,
    )
    .get(args.actorScope, args.route, args.key) as
    | { request_hash: string; status_code: number; response_body: string | null }
    | undefined;
  if (!row) return { kind: "execute" };
  if (row.request_hash !== hashRequest(args.requestBody)) return { kind: "collision" };
  return {
    kind: "replay",
    statusCode: row.status_code,
    body: row.response_body ? JSON.parse(row.response_body) : null,
  };
}

export function recordIdempotency(args: {
  actorScope: string;
  route: string;
  key: string;
  requestBody: string;
  statusCode: number;
  resourceType: string | null;
  resourceId: string | null;
  responseBody: unknown;
}): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO idempotency_keys
       (id, actor_scope, route, key, request_hash, status_code, resource_type, resource_id, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    crypto.randomUUID(),
    args.actorScope,
    args.route,
    args.key,
    hashRequest(args.requestBody),
    args.statusCode,
    args.resourceType,
    args.resourceId,
    JSON.stringify(args.responseBody),
    new Date().toISOString(),
  );
}

function hashRequest(body: string): string {
  return crypto.createHash("sha256").update(body).digest("hex");
}
