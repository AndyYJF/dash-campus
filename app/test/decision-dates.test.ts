import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceDateExclusions } from "@/domain/decision-dates";
import { decisionScope, validateDecision } from "@/workflows/agent-decide";

const today = "2026-10-12";
test("来源日期语义必须有真实主人原话与正确参照日期；伪引用、指代和错日期不采纳", () => {
  const text = "周四课满，那天不排，挪到别的天";
  assert.deepEqual(sourceDateExclusions([{ date: "2026-10-15", excerpt: "周四" }], text, today), ["2026-10-15"]);
  assert.deepEqual(sourceDateExclusions([{ date: "2026-10-16", excerpt: "周四" }, { date: "2026-10-15", excerpt: "那天" }, { date: "2026-10-15", excerpt: "2026-10-15" }], text, today), []);
});
test("去掉来源日期后，已有目标范围和后续主人明确选择的日期仍有效", () => {
  const text = "周四课满，那天不排，挪到别的天";
  const excludes = sourceDateExclusions([{ date: "2026-10-15", excerpt: "周四" }], text, today);
  assert.deepEqual(decisionScope(text, today, [], null, excludes), { dateFrom: today, dateTo: "2026-10-18", explicit: false });
  assert.deepEqual(decisionScope(text, today, [], { dateFrom: "2026-10-14", dateTo: "2026-10-16" }, excludes), { dateFrom: "2026-10-14", dateTo: "2026-10-16", explicit: true, inherited: true });
  assert.deepEqual(decisionScope(text, today, [{ answer: "这次只动周四" }], null, excludes), { dateFrom: "2026-10-15", dateTo: "2026-10-15", explicit: true });
  assert.match(validateDecision([{ op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-18" }], today, { dateFrom: "2026-10-14", dateTo: "2026-10-16", explicit: true })!, /超出了/);
});
