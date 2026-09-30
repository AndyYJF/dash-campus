import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll } from "./helpers";
import { checkIdempotency, recordIdempotency } from "@/workflows/idempotency";

before(migrateAll);

const base = { actorScope: "owner:1", route: "tasks", key: "abc" };

test("幂等键：首次 execute，同体重放 replay，异体碰撞 409", () => {
  assert.equal(checkIdempotency({ ...base, requestBody: '{"a":1}' }).kind, "execute");

  recordIdempotency({
    ...base,
    requestBody: '{"a":1}',
    statusCode: 201,
    resourceType: "task",
    resourceId: "task-1",
    responseBody: { id: "task-1" },
  });

  const replay = checkIdempotency({ ...base, requestBody: '{"a":1}' });
  assert.equal(replay.kind, "replay");
  if (replay.kind === "replay") {
    assert.equal(replay.statusCode, 201);
    assert.deepEqual(replay.body, { id: "task-1" });
  }

  assert.equal(checkIdempotency({ ...base, requestBody: '{"a":2}' }).kind, "collision");
});

test("幂等键按 (actor_scope, route, key) 三元组隔离", () => {
  assert.equal(
    checkIdempotency({ ...base, route: "goals", requestBody: '{"a":1}' }).kind,
    "execute",
  );
});
