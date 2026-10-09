import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { DEMO_SESSION_COOKIE, isDemoMode } from "@/domain/demo";

/**
 * 会话：明文 token 只发给客户端一次，库里只存 SHA-256 摘要。
 * CSRF token 与会话绑定，变更请求必须携带匹配的 x-csrf-token 头。
 */

export const SESSION_COOKIE = "dash_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

/** 本实例实际使用的会话 Cookie 名：演示实例另用一个名字，和同域的正式实例互不覆盖 */
export function sessionCookieName(): string {
  return isDemoMode() ? DEMO_SESSION_COOKIE : SESSION_COOKIE;
}

export type SessionRecord = {
  id: string;
  ownerId: number;
  csrfToken: string;
  createdAt: string;
  expiresAt: string;
  revokedAt: string | null;
};

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function createSession(ownerId: number = 1, ttlMs: number = SESSION_TTL_MS): { session: SessionRecord; token: string } {
  const db = getDb();
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("base64url");
  const csrfToken = crypto.randomBytes(24).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs).toISOString();
  db.prepare(
    `INSERT INTO sessions (id, owner_id, token_hash, csrf_token, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, ownerId, hashToken(token), csrfToken, now.toISOString(), expiresAt);
  return { session: { id, ownerId, csrfToken, createdAt: now.toISOString(), expiresAt, revokedAt: null }, token };
}

/** 校验 token，返回有效会话；过期或撤销返回 null */
export function findSessionByToken(token: string): SessionRecord | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, owner_id, csrf_token, created_at, expires_at, revoked_at
       FROM sessions WHERE token_hash = ?`,
    )
    .get(hashToken(token)) as
    | {
        id: string;
        owner_id: number;
        csrf_token: string;
        created_at: string;
        expires_at: string;
        revoked_at: string | null;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  return {
    id: row.id,
    ownerId: row.owner_id,
    csrfToken: row.csrf_token,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

export function revokeSession(sessionId: string): boolean {
  const db = getDb();
  const r = db
    .prepare(`UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`)
    .run(new Date().toISOString(), sessionId);
  return r.changes > 0;
}

export function listSessions(): SessionRecord[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, owner_id, csrf_token, created_at, expires_at, revoked_at
       FROM sessions ORDER BY created_at DESC`,
    )
    .all() as Array<{
    id: string;
    owner_id: number;
    csrf_token: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    ownerId: r.owner_id,
    csrfToken: r.csrf_token,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
  }));
}

// owner 操作
export function hasOwner(): boolean {
  const db = getDb();
  const row = db.prepare(`SELECT id FROM owner WHERE id = 1`).get();
  return Boolean(row);
}

export function getOwnerCreatedAt(): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT created_at FROM owner WHERE id = 1`).get() as
    | { created_at: string }
    | undefined;
  return row ? row.created_at : null;
}

export function createOwner(passwordHash: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO owner (id, password_hash, created_at, setup_completed_at)
     VALUES (1, ?, ?, ?)`,
  ).run(passwordHash, now, now);
}

export function getOwnerPasswordHash(): string | null {
  const db = getDb();
  const row = db.prepare(`SELECT password_hash FROM owner WHERE id = 1`).get() as
    | { password_hash: string }
    | undefined;
  return row ? row.password_hash : null;
}
