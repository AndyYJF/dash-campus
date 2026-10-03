import assert from "node:assert/strict";
import { test } from "node:test";
import { nextLogDraftDate } from "@/domain/log-draft";

test("跨天只更新空白自动日期；已有文字、主动补记、旧版本未知意图和手工清空日期全部保留", () => {
  const empty = { occurredOn: "2026-10-02", dateMode: "auto" as const, progress: "", blocker: "" };
  assert.equal(nextLogDraftDate(empty, "2026-10-03"), "2026-10-03");
  assert.equal(nextLogDraftDate({ ...empty, progress: "昨天推进的内容" }, "2026-10-03"), "2026-10-02");
  assert.equal(nextLogDraftDate({ ...empty, blocker: "卡点" }, "2026-10-03"), "2026-10-02");
  assert.equal(nextLogDraftDate({ ...empty, dateMode: "manual" }, "2026-10-03"), "2026-10-02");
  assert.equal(nextLogDraftDate({ ...empty, dateMode: "legacy" }, "2026-10-03"), "2026-10-02");
  assert.equal(nextLogDraftDate({ ...empty, dateMode: "manual", occurredOn: "" }, "2026-10-03"), "");
  assert.equal(nextLogDraftDate({ ...empty, occurredOn: "" }, "2026-10-03"), "2026-10-03");
  assert.equal(nextLogDraftDate(empty, ""), "2026-10-02");
});
