import assert from "node:assert/strict";
import { test } from "node:test";
import { dueFromText, estimateFromText, isCompletionReport, matchTask, pickCandidate } from "@/domain/task-text";

/** U04/E11/E12：中文时长、绝对日期与钟点、相对日期的确定性解析；U03：完成表达与对象匹配 */

const REF = "2026-10-04"; // 周日

test("E12：中文时长", () => {
  assert.equal(estimateFromText("学了一个半小时"), 90);
  assert.equal(estimateFromText("预计两小时"), 120);
  assert.equal(estimateFromText("大概1.5小时"), 90);
  assert.equal(estimateFromText("两个半小时"), 150);
  assert.equal(estimateFromText("1小时20分钟"), 80);
  assert.equal(estimateFromText("半小时就够"), 30);
  assert.equal(estimateFromText("四十五分钟"), 45);
  assert.equal(estimateFromText("预计30分钟"), 30);
  assert.equal(estimateFromText("比预计久"), null, "只说比预计久：实际分钟仍未知");
});

test("E11：绝对日期 + 钟点；相对日期以参照日为准", () => {
  assert.deepEqual(dueFromText("2026-10-05 10:00前交报告，预计30分钟", REF), { localDate: "2026-10-05", localTime: "10:00" });
  assert.deepEqual(dueFromText("10月8日下午3点前交", REF), { localDate: "2026-10-08", localTime: "15:00" });
  assert.deepEqual(dueFromText("明天上午前交实验报告", REF), { localDate: "2026-10-05", localTime: "12:00" });
  assert.deepEqual(dueFromText("后天要交作业", REF), { localDate: "2026-10-06", localTime: null });
  assert.deepEqual(dueFromText("下周三晚上8点半截止", REF), { localDate: "2026-10-07", localTime: "20:30" });
  assert.deepEqual(dueFromText("周五交", "2026-10-07"), { localDate: "2026-10-09", localTime: null });
  assert.deepEqual(dueFromText("1月3日交", REF), { localDate: "2027-01-03", localTime: null }, "已过去的月日指下一年");
  assert.deepEqual(dueFromText("今晚10点前交", REF), { localDate: REF, localTime: "22:00" });
  assert.equal(dueFromText("复现基线，估两小时", REF), null);
  assert.equal(dueFromText("2026-02-30 交", REF), null, "不存在的日期不猜");
});

test("U03：完成表达与对象匹配——唯一才绑定，并列交给用户", () => {
  assert.equal(isCompletionReport("操作系统实验报告做完了"), true);
  assert.equal(isCompletionReport("报告还没做完"), false);
  assert.equal(isCompletionReport("快写完了"), false);
  assert.equal(isCompletionReport("明天要交报告"), false);
  const tasks = [
    { id: "a", title: "操作系统实验报告" },
    { id: "b", title: "英语读书报告" },
    { id: "c", title: "复现基线" },
  ];
  assert.deepEqual(matchTask("操作系统实验报告做完了", tasks), { kind: "one", task: tasks[0] });
  assert.deepEqual(matchTask("报告做完了", tasks), { kind: "ambiguous", candidates: [tasks[0], tasks[1]] });
  assert.deepEqual(matchTask("洗完衣服了", tasks), { kind: "none" });
  assert.equal(pickCandidate("第二个", [tasks[0]!, tasks[1]!])?.id, "b");
  assert.equal(pickCandidate("英语的", [tasks[0]!, tasks[1]!])?.id, "b");
  assert.equal(pickCandidate("都不是", [tasks[0]!, tasks[1]!]), null);
});
