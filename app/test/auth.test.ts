import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll, getDb } from "./helpers";
import { hashPassword, verifyPassword } from "@/domain/password";
import {
  createOwner,
  createSession,
  findSessionByToken,
  hasOwner,
  listSessions,
  revokeSession,
} from "@/domain/session";

before(migrateAll);

test("密码摘要可校验，且摘要不含明文", () => {
  const hash = hashPassword("my-secret-pass");
  assert.notEqual(hash, "my-secret-pass");
  assert.ok(verifyPassword("my-secret-pass", hash));
  assert.ok(!verifyPassword("wrong-pass", hash));
});

test("唯一主人：owner.id 固定为 1，重复创建被 CHECK 拒绝", () => {
  assert.ok(!hasOwner());
  createOwner(hashPassword("password-123"));
  assert.ok(hasOwner());
  assert.throws(
    () => createOwner(hashPassword("password-123")),
    /(CHECK constraint failed|UNIQUE constraint failed: owner\.id)/,
  );
  const db = getDb();
  const rows = db.prepare("SELECT id FROM owner").all() as Array<{ id: number }>;
  assert.deepEqual(rows.map((r) => r.id), [1]);
});

test("会话生命周期：创建→校验→撤销→失效；库里只存摘要", () => {
  const { session, token } = createSession(1);
  assert.ok(findSessionByToken(token));
  assert.equal(findSessionByToken(token)!.id, session.id);

  const db = getDb();
  const row = db
    .prepare("SELECT token_hash FROM sessions WHERE id = ?")
    .get(session.id) as { token_hash: string };
  assert.notEqual(row.token_hash, token);

  revokeSession(session.id);
  assert.equal(findSessionByToken(token), null);
  assert.ok(listSessions().some((s) => s.id === session.id && s.revokedAt !== null));
});

test("错误 token 找不到会话", () => {
  assert.equal(findSessionByToken("not-a-real-token"), null);
});
