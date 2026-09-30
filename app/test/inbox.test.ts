import assert from "node:assert/strict";
import { test, before } from "node:test";
import { migrateAll } from "./helpers";
import { noticeImportSchema, type NoticeImport } from "@/contracts/inbox";
import { evaluateCondition } from "@/domain/conditions";
import { upsertFact, createRule, updateRule, listFacts } from "@/repositories/profile";
import {
  createSource,
  getDecisionByRevision,
  getMessage,
  getMessageByExternalId,
  getRevision,
  getTaskLink,
  listMessages,
} from "@/repositories/inbox";
import { getTask, listTasks, updateTask } from "@/repositories/planning";
import {
  createTaskFromAction,
  importNotice,
  reevaluateAllCurrent,
  resolveThisRevision,
  selectRevision,
  sourceChangeDiff,
} from "@/workflows/inbox";

/** T4 收件箱：F1–F5 固定验收 + 修订冲突 + 幂等去重 + 规则匹配 */

let srcToken = "";

before(() => {
  migrateAll();
  srcToken = createSource("src1", "测试来源").token;
});

function makeImport(
  overrides: Partial<NoticeImport> = {},
  structured?: NoticeImport["structured"] | null,
): NoticeImport {
  const defaults = {
    schemaVersion: 1 as const,
    source: "src1",
    externalId: "n-1",
    revisionKey: "r1",
    revisionOrder: 1,
    occurredAt: "2026-09-28T10:00:00.000Z",
    text: "面向所有本科一年级学生的讲座报名，需提交表单。",
  };
  const defaultStructured: NoticeImport["structured"] = {
    noticeType: "campus_event",
    condition: {
      kind: "leaf",
      field: "education_level",
      op: "eq",
      value: "本科一年级",
      quote: "面向所有本科一年级学生",
    },
    action: { actionKey: "act-1", title: "提交讲座表单", description: "", required: true },
  };
  // structured=null 表示仅存原文；undefined 使用默认
  const effectiveStructured =
    structured === undefined ? defaultStructured : (structured ?? undefined);
  return noticeImportSchema.parse({ ...defaults, structured: effectiveStructured, ...overrides });
}

test("三值求值：all/any 语义、未知字段、未填字段", () => {
  const facts = { education_level: "本科一年级", campus: "东校区" };
  const leaf = (field: string, op: "eq" | "in", value: string | string[]) =>
    ({ kind: "leaf", field, op, value, quote: "q" }) as never;
  assert.equal(evaluateCondition(leaf("education_level", "eq", "本科一年级"), facts), "TRUE");
  assert.equal(
    evaluateCondition(leaf("education_level", "in", ["硕士研究生", "博士研究生"]), facts),
    "FALSE",
  );
  // 未填写字段 → UNKNOWN（F3：不据标题猜资格）
  assert.equal(evaluateCondition(leaf("program", "eq", "计算机科学"), facts), "UNKNOWN");
  // 不支持的字段 → UNKNOWN，不折叠
  assert.equal(evaluateCondition(leaf("gpa", "eq", "4.0"), facts), "UNKNOWN");
  assert.equal(
    evaluateCondition(
      { kind: "all", children: [leaf("education_level", "eq", "本科一年级"), leaf("campus", "eq", "东校区")] },
      facts,
    ),
    "TRUE",
  );
  assert.equal(
    evaluateCondition(
      { kind: "all", children: [leaf("education_level", "eq", "本科一年级"), leaf("program", "eq", "计算机科学")] },
      facts,
    ),
    "UNKNOWN",
  );
  // any：全 FALSE 才 FALSE
  assert.equal(
    evaluateCondition(
      { kind: "any", children: [leaf("education_level", "eq", "硕士研究生"), leaf("campus", "eq", "西校区")] },
      facts,
    ),
    "FALSE",
  );
  // any：有 UNKNOWN 且无 TRUE → UNKNOWN
  assert.equal(
    evaluateCondition(
      { kind: "any", children: [leaf("program", "eq", "计算机科学"), leaf("campus", "eq", "西校区")] },
      facts,
    ),
    "UNKNOWN",
  );
});

test("F1 身份符合：TRUE → action 草案，有原文引用", () => {
  upsertFact("education_level", "本科一年级", 0);
  const result = importNotice(makeImport(), srcToken);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.kind, "created");
    const decision = getDecisionByRevision(result.revisionId)!;
    assert.equal(decision.applicability, "TRUE");
    assert.equal(decision.partition, "action");
    const revision = getRevision(result.revisionId)!;
    assert.equal(
      (revision.structured!.condition as { quote: string }).quote,
      "面向所有本科一年级学生",
    );
  }
});

test("F2 身份不符：FALSE → folded，可找回", () => {
  const result = importNotice(
    makeImport(
      { externalId: "n-grad", text: "本活动仅限研究生参加。" },
      {
        noticeType: "campus_event",
        condition: {
          kind: "leaf",
          field: "education_level",
          op: "in",
          value: ["硕士研究生", "博士研究生"],
          quote: "仅限研究生",
        },
        action: { actionKey: "act-grad", title: "研究生活动", description: "", required: true },
      },
    ),
    srcToken,
  );
  assert.ok(result.ok);
  if (result.ok) {
    const decision = getDecisionByRevision(result.revisionId)!;
    assert.equal(decision.applicability, "FALSE");
    assert.equal(decision.partition, "folded");
    assert.ok(listMessages().some((m) => m.id === result.messageId), "folded 可找回");
  }
});

test("F3 条件未知：UNKNOWN → review；仅存原文不假装筛选", () => {
  const result = importNotice(
    makeImport(
      { externalId: "n-unknown", text: "需要计算机科学专业背景。" },
      {
        noticeType: "campus_event",
        condition: {
          kind: "leaf",
          field: "program",
          op: "eq",
          value: "计算机科学",
          quote: "需要计算机科学专业背景",
        },
        action: { actionKey: "act-2", title: "专业活动", description: "", required: true },
      },
    ),
    srcToken,
  );
  assert.ok(result.ok);
  if (result.ok) {
    const decision = getDecisionByRevision(result.revisionId)!;
    assert.equal(decision.applicability, "UNKNOWN");
    assert.equal(decision.partition, "review");
  }
  const raw = importNotice(
    makeImport({ externalId: "n-raw", text: "一条没有任何结构化数据的原文通知。" }, null),
    srcToken,
  );
  assert.ok(raw.ok);
  if (raw.ok) {
    const decision = getDecisionByRevision(raw.revisionId)!;
    assert.equal(decision.applicability, null);
    assert.equal(decision.partition, "review");
  }
});

test("F4 纠正作用域：仅本条不改变身份；下一次同类活动不受影响", () => {
  const voluntary: NoticeImport["structured"] = {
    noticeType: "voluntary_event",
    condition: {
      kind: "leaf",
      field: "education_level",
      op: "eq",
      value: "本科一年级",
      quote: "自愿参加",
    },
    action: { actionKey: "act-v", title: "自愿活动A", description: "", required: false },
  };
  const first = importNotice(
    makeImport({ externalId: "v-1", text: "自愿活动A，自愿参加。" }, voluntary),
    srcToken,
  );
  assert.ok(first.ok);
  if (first.ok) {
    const decision = getDecisionByRevision(first.revisionId)!;
    assert.equal(decision.partition, "opportunity", "自愿且 TRUE → opportunity");
    assert.equal(resolveThisRevision(first.messageId, "folded"), "ok");
    assert.equal(getDecisionByRevision(first.revisionId)!.partition, "folded");
  }
  const second = importNotice(
    makeImport({ externalId: "v-2", text: "自愿活动B，自愿参加。" }, voluntary),
    srcToken,
  );
  assert.ok(second.ok);
  if (second.ok) {
    const decision = getDecisionByRevision(second.revisionId)!;
    assert.equal(decision.partition, "opportunity", "单条纠正不影响新通知");
    assert.equal(listFacts().length, 1, "身份事实不变");
    assert.equal(listFacts()[0].value, "本科一年级");
  }
});

const f5Structured = (title: string): NoticeImport["structured"] => ({
  noticeType: "campus_event",
  condition: {
    kind: "leaf",
    field: "education_level",
    op: "eq",
    value: "本科一年级",
    quote: "面向本科一年级",
  },
  action: { actionKey: "act-f5", title, description: "", required: true },
});

test("F5 修订与去重：r1→r2→r1 不回退；标题不被覆盖；任务不复制", () => {
  const r1 = importNotice(
    makeImport(
      { externalId: "f5-1", revisionKey: "r1", revisionOrder: 1, text: "第一次发布：提交实验报名。" },
      f5Structured("实验报名"),
    ),
    srcToken,
  );
  assert.ok(r1.ok && r1.kind === "created");

  // 建任务（主人显式动作）
  const message1 = getMessageByExternalId("src1", "f5-1")!;
  const created = createTaskFromAction(message1.id, "act-f5");
  assert.ok(created.kind === "created");
  const taskId = created.taskId;

  // 主人在 r2 前改过任务标题
  updateTask(taskId, { title: "实验报名（我的版本）" }, getTask(taskId)!.version);

  // r2 到达（同 actionKey，来源改了标题）
  const r2 = importNotice(
    makeImport(
      {
        externalId: "f5-1",
        revisionKey: "r2",
        revisionOrder: 2,
        text: "第二次发布：提交实验报名（更新标题）。",
      },
      f5Structured("实验报名（来源新标题）"),
    ),
    srcToken,
  );
  assert.ok(r2.ok && r2.kind === "created" && r2.becameCurrent);

  const message = getMessageByExternalId("src1", "f5-1")!;
  assert.equal(getRevision(message.currentRevisionId!)!.revisionKey, "r2", "current=r2");

  // 任务标题与状态不被来源覆盖
  const taskAfter = getTask(taskId)!;
  assert.equal(taskAfter.title, "实验报名（我的版本）", "来源更新不覆盖用户任务标题");
  assert.equal(taskAfter.status, "todo");

  // 任务不复制：同 actionKey 再创建 → exists + 差异草案
  const again = createTaskFromAction(message.id, "act-f5");
  assert.ok(again.kind === "exists");
  if (again.kind === "exists") {
    assert.equal(again.taskId, taskId);
    assert.ok(again.diff.length === 1 && again.diff[0].changed, "标记来源变化");
    assert.ok(
      again.diff[0].fields.some((f) => f.field === "title" && f.draftValue === "实验报名（来源新标题）"),
    );
  }

  // r1 重复到达（同 key 同正文）→ 重放，current 不回退
  const r1again = importNotice(
    makeImport(
      { externalId: "f5-1", revisionKey: "r1", revisionOrder: 1, text: "第一次发布：提交实验报名。" },
      f5Structured("实验报名"),
    ),
    srcToken,
  );
  assert.ok(r1again.ok && r1again.kind === "replay");
  const messageFinal = getMessageByExternalId("src1", "f5-1")!;
  assert.equal(getRevision(messageFinal.currentRevisionId!)!.revisionKey, "r2", "r1→r2→r1 不回退");

  // 同 key 异正文 → 冲突
  const collision = importNotice(
    makeImport({ externalId: "f5-1", revisionKey: "r1", revisionOrder: 1, text: "被篡改的正文。" }),
    srcToken,
  );
  assert.ok(!collision.ok && collision.error === "revision_collision");

  assert.equal(listTasks().filter((t) => t.title.includes("实验报名")).length, 1, "任务不复制");
  assert.equal(listMessages().filter((m) => m.externalId === "f5-1").length, 1, "一个逻辑通知");
});


test("不可排序修订冲突：revision_conflict 待主人选择，不按抵达时间猜新旧", () => {
  const v1 = importNotice(
    makeImport({ externalId: "cf-1", revisionKey: "k1", revisionOrder: null, text: "无序版本一。" }, undefined),
    srcToken,
  );
  assert.ok(v1.ok && v1.kind === "created");
  const v2 = importNotice(
    makeImport(
      { externalId: "cf-1", revisionKey: "k2", revisionOrder: null, text: "无序版本二（内容不同）。" },
      undefined,
    ),
    srcToken,
  );
  assert.ok(v2.ok && v2.kind === "revision_conflict");
  const message = getMessageByExternalId("src1", "cf-1")!;
  assert.equal(message.status, "revision_conflict");
  // current 保持先到的版本（不按网络抵达时间猜新旧），待主人选择
  assert.equal(getRevision(message.currentRevisionId!)!.revisionKey, "k1");
  assert.equal(selectRevision(message.id, v2.ok ? v2.revisionId : ""), "ok");
  const after = getMessage(message.id)!;
  assert.equal(after.status, "active");
  assert.equal(getRevision(after.currentRevisionId!)!.revisionKey, "k2");
});

test("导入 token 只能向配置允许的 source 写入", () => {
  const bad = importNotice(makeImport({ externalId: "sec-1" }), "wrong-token");
  assert.ok(!bad.ok && bad.error === "source_forbidden");
  const noSource = importNotice(makeImport({ externalId: "sec-1", source: "nope" }), srcToken);
  assert.ok(!noSource.ok && noSource.error === "source_forbidden");
});

test("人工规则：匹配优先于基础分区；同优先级冲突 → review；事实变化重评", () => {
  const r1 = createRule({
    source: "src1",
    noticeType: "campus_event",
    condition: {
      kind: "leaf",
      field: "education_level",
      op: "eq",
      value: "本科一年级",
      quote: "规则条件",
    },
    outputPartition: "folded",
    priority: 1,
  });
  updateRule(r1.id, { enabled: true }, r1.version);
  reevaluateAllCurrent();

  // 启用即重评：F1 的消息（基础 action）被规则改为 folded
  const f1Message = getMessageByExternalId("src1", "n-1")!;
  const f1Decision = getDecisionByRevision(f1Message.currentRevisionId!)!;
  assert.equal(f1Decision.partition, "folded", "人工规则改变分区");
  assert.equal(f1Decision.matchedRuleId, r1.id);

  // 同优先级第二条规则 → 冲突 → review
  const r2 = createRule({
    source: "src1",
    noticeType: "campus_event",
    condition: {
      kind: "leaf",
      field: "education_level",
      op: "eq",
      value: "本科一年级",
      quote: "规则条件2",
    },
    outputPartition: "action",
    priority: 1,
  });
  updateRule(r2.id, { enabled: true }, r2.version);
  reevaluateAllCurrent();
  const f1Decision2 = getDecisionByRevision(f1Message.currentRevisionId!)!;
  assert.equal(f1Decision2.partition, "review", "规则冲突 → review");

  // 更正身份 → 受影响判断重评
  const edu = listFacts().find((f) => f.field === "education_level")!;
  upsertFact("education_level", "硕士研究生", edu.version);
  reevaluateAllCurrent();
  const f1Decision3 = getDecisionByRevision(f1Message.currentRevisionId!)!;
  assert.equal(f1Decision3.applicability, "FALSE", "身份变化重评受影响判断");

  // 恢复事实避免影响其他用例
  const eduNow = listFacts().find((f) => f.field === "education_level")!;
  upsertFact("education_level", "本科一年级", eduNow.version);
  reevaluateAllCurrent();
});

test("来源变化差异：sourceChangeDiff 标记而不覆盖", () => {
  const message = getMessageByExternalId("src1", "f5-1")!;
  const diff = sourceChangeDiff(message.id);
  assert.ok(diff.length === 1);
  assert.equal(diff[0].actionKey, "act-f5");
  assert.ok(diff[0].changed, "来源变化被标记");
  assert.equal(getTaskLink(message.id, "act-f5")!.taskId, getTask(diff[0].taskId)!.id);
});

