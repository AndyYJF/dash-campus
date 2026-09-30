import assert from "node:assert/strict";
import { test } from "node:test";
import { dueBoundaryUtc, resolveWallTime, wallTimeToUtc } from "@/domain/time";

test("F19 DST：不存在的时刻后移到第一个有效时刻并标记", () => {
  // 纽约 2026-03-08 02:00 跳到 03:00
  const r = resolveWallTime("2026-03-08", "02:30", "America/New_York");
  assert.equal(r.instant.toISOString(), "2026-03-08T07:00:00.000Z"); // 当地 03:00 EDT
  assert.equal(r.adjustment, "gap_shifted");
});

test("F19 DST：重复的时刻取较早偏移并标记", () => {
  // 纽约 2026-11-01 02:00 回拨到 01:00，01:30 出现两次
  const r = resolveWallTime("2026-11-01", "01:30", "America/New_York");
  assert.equal(r.instant.toISOString(), "2026-11-01T05:30:00.000Z"); // 较早的 01:30 EDT
  assert.equal(r.adjustment, "overlap_earlier");
  // 伦敦 2026-10-25 01:30 同理
  assert.equal(wallTimeToUtc("2026-10-25", "01:30", "Europe/London").toISOString(), "2026-10-25T00:30:00.000Z");
});

test("F19：普通时刻不调整；无 DST 时区不受影响；转换日前后时刻正确", () => {
  assert.deepEqual(resolveWallTime("2026-09-30", "23:30", "Asia/Shanghai"), {
    instant: new Date("2026-09-30T15:30:00.000Z"),
    adjustment: "none",
  });
  assert.equal(wallTimeToUtc("2026-03-08", "01:59", "America/New_York").toISOString(), "2026-03-08T06:59:00.000Z");
  assert.equal(wallTimeToUtc("2026-03-08", "03:00", "America/New_York").toISOString(), "2026-03-08T07:00:00.000Z");
  assert.equal(wallTimeToUtc("2026-11-01", "02:00", "America/New_York").toISOString(), "2026-11-01T07:00:00.000Z");
  // 伦敦春季跳过 01:00–02:00：日期截止的边界（次日 00:00）不受影响
  assert.equal(
    dueBoundaryUtc({ kind: "date", localDate: "2026-03-28", timezone: "Europe/London" }),
    "2026-03-29T00:00:00.000Z",
  );
  assert.equal(wallTimeToUtc("2026-03-29", "01:15", "Europe/London").toISOString(), "2026-03-29T01:00:00.000Z");
});

test("F19：午夜被跳过的时区，日期截止边界落到当天第一个有效时刻", () => {
  // 圣地亚哥 2026-09-06 00:00 跳到 01:00（夏令时开始于午夜）
  const r = resolveWallTime("2026-09-06", "00:00", "America/Santiago");
  assert.equal(r.adjustment, "gap_shifted");
  assert.equal(r.instant.toISOString(), "2026-09-06T04:00:00.000Z"); // 当地 01:00 -03
});
