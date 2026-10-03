import {
  type NoticeImport,
  type Partition,
  type Tri,
  PROFILE_FIELDS,
  profileRuleSchema,
} from "@/contracts/inbox";
import { evaluateCondition } from "@/domain/conditions";
import { factsMap, getFactByField, listRules, upsertFact, createRule, updateRule, type ProfileRuleRow } from "@/repositories/profile";
import {
  createMessage,
  createRevision,
  createTaskLink,
  getDecisionByRevision,
  getMessage,
  getMessageByExternalId,
  getRevision,
  getRevisionByKey,
  getTaskLink,
  listMessages,
  listTaskLinks,
  setMessageCurrent,
  setMessageStatus,
  sourceTokenMatches,
  upsertDecision,
  type InboxMessageRow,
  type InboxRevisionRow,
} from "@/repositories/inbox";
import { enqueueNoticeExtraction } from "./notice-extraction";
import { createTask, getTask } from "@/repositories/planning";

/**
 * 收件箱工作流（计划 v1.2 第 5 节）。
 * - 导入：同 revisionKey 同正文重放返回既有资源；异正文 409；r1→r2→r1 不回退；
 *   不可排序且内容不同的新版本存为 revision_conflict 待主人选择。
 * - 分区优先级：同修订人工覆盖 > 匹配人工规则（显式 priority，冲突则 review）> 条件树 > 仅存原文。
 * - 来源更新永不自动覆盖已建任务；只生成差异草案（F5）。
 */

export type ImportOk =
  | { ok: true; kind: "created"; messageId: string; revisionId: string; becameCurrent: boolean }
  | { ok: true; kind: "replay"; messageId: string; revisionId: string }
  | { ok: true; kind: "history"; messageId: string; revisionId: string }
  | { ok: true; kind: "revision_conflict"; messageId: string; revisionId: string };

export type ImportError =
  | { ok: false; error: "source_forbidden" }
  | { ok: false; error: "revision_collision" };

export function importNotice(payload: NoticeImport, token: string, options: { automaticExtraction?: boolean } = {}): ImportOk | ImportError {
  // 导入 token 只能向配置允许的 source 写入
  if (!sourceTokenMatches(payload.source, token)) return { ok: false, error: "source_forbidden" };

  return importVerifiedNotice(payload, options);
}

/** Internal entry point. Call only after authenticating the source or owner. */
export function importVerifiedNotice(payload: NoticeImport, options: { automaticExtraction?: boolean } = {}): ImportOk | ImportError {
  return getDb().transaction(() => importNoticeTransaction(payload, options.automaticExtraction !== false)).immediate();
}

function importNoticeTransaction(payload: NoticeImport, automaticExtraction: boolean): ImportOk | ImportError {
  const existingMessage = getMessageByExternalId(payload.source, payload.externalId);
  if (!existingMessage) {
    const message = createMessage(payload.source, payload.externalId, "");
    const revision = createRevision({
      messageId: message.id,
      revisionKey: payload.revisionKey,
      revisionOrder: payload.revisionOrder,
      occurredAt: payload.occurredAt,
      text: payload.text,
      sourceUrl: payload.sourceUrl ?? null,
      structured: payload.structured ?? null,
    });
    setMessageCurrent(message.id, revision.id, "active");
    computeAndStoreDecision(message, revision);
    if (!revision.structured && automaticExtraction) enqueueNoticeExtraction(revision.id);
    return { ok: true, kind: "created", messageId: message.id, revisionId: revision.id, becameCurrent: true };
  }

  const message = existingMessage;
  // 同 revisionKey：同正文重放返回既有资源；异正文 409 SOURCE_REVISION_COLLISION
  const existingRevision = getRevisionByKey(message.id, payload.revisionKey);
  if (existingRevision) {
    if (existingRevision.text !== payload.text) return { ok: false, error: "revision_collision" };
    return { ok: true, kind: "replay", messageId: message.id, revisionId: existingRevision.id };
  }

  // 新修订
  const revision = createRevision({
    messageId: message.id,
    revisionKey: payload.revisionKey,
    revisionOrder: payload.revisionOrder,
    occurredAt: payload.occurredAt,
    text: payload.text,
    sourceUrl: payload.sourceUrl ?? null,
    structured: payload.structured ?? null,
  });
  const current = message.currentRevisionId ? getRevision(message.currentRevisionId) : null;

  if (message.status === "revision_conflict") {
    // 已有待选择冲突：新版本一并加入待选择，不猜新旧
    return { ok: true, kind: "revision_conflict", messageId: message.id, revisionId: revision.id };
  }
  if (payload.revisionOrder === null || !current || current.revisionOrder === null) {
    // 不可排序且内容不同 → 存为 revision_conflict 待主人选择
    setMessageStatus(message.id, "revision_conflict");
    return { ok: true, kind: "revision_conflict", messageId: message.id, revisionId: revision.id };
  }
  if (payload.revisionOrder > current.revisionOrder) {
    // 顺序更新的版本成为 current；当前版需重评（不继承旧修订的人工覆盖）
    setMessageCurrent(message.id, revision.id, "active");
    computeAndStoreDecision(message, revision);
    if (!revision.structured && automaticExtraction) enqueueNoticeExtraction(revision.id);
    return { ok: true, kind: "created", messageId: message.id, revisionId: revision.id, becameCurrent: true };
  }
  // 顺序不晚于当前：入历史，current 不回退（r1→r2→r1 的 r1 已按同 key 重放处理）
  return { ok: true, kind: "history", messageId: message.id, revisionId: revision.id };
}

/** 分区计算并落库（同修订重复计算保留人工覆盖；新修订不带旧覆盖） */
export function computeAndStoreDecision(
  message: InboxMessageRow,
  revision: InboxRevisionRow,
): ReturnType<typeof getDecisionByRevision> {
  const facts = factsMap();
  const structured = revision.structured;

  // 条件树三值计算；仅存原文时 applicability 为 null、分区 review，不假装筛选已运行
  let applicability: Tri | null = null;
  let base: Partition = "review";
  if (structured?.condition) {
    applicability = evaluateCondition(structured.condition, facts);
    const action = structured.action;
    if (action) {
      base =
        applicability === "TRUE"
          ? action.required
            ? "action"
            : "opportunity"
          : applicability === "FALSE"
            ? "folded"
            : "review";
    } else {
      base =
        applicability === "TRUE" ? "info" : applicability === "FALSE" ? "folded" : "review";
    }
  }

  // 匹配的人工规则：scope 命中 + 条件 TRUE；显式 priority，最高优先级冲突则 review
  let matchedRuleId: string | null = null;
  let matchedRuleVersion: number | null = null;
  let rulePartition: Partition | null = null;
  if (structured?.noticeType) {
    const matching = listRules({ enabledOnly: true }).filter(
      (r) =>
        (r.source === "*" || r.source === message.sourceId) &&
        r.noticeType === structured.noticeType &&
        evaluateCondition(r.condition as Parameters<typeof evaluateCondition>[0], facts) === "TRUE",
    );
    if (matching.length > 0) {
      const topPriority = Math.max(...matching.map((r) => r.priority));
      const top = matching.filter((r) => r.priority === topPriority);
      if (top.length === 1) {
        matchedRuleId = top[0].id;
        matchedRuleVersion = top[0].version;
        rulePartition = top[0].outputPartition as Partition;
      } else {
        rulePartition = "review"; // 规则冲突 → review
      }
    }
  }

  // 同一修订人工覆盖优先（事实/规则变化重评时不丢主人的明确覆盖）
  const existing = getDecisionByRevision(revision.id);
  const manualPartition = existing?.manualPartition ?? null;
  const partition: Partition = manualPartition ?? rulePartition ?? base;

  return upsertDecision({
    messageId: message.id,
    revisionId: revision.id,
    applicability,
    basePartition: base,
    matchedRuleId,
    matchedRuleVersion,
    manualPartition,
    partition,
  });
}

/** 事实或规则变化后重评所有当前修订（"受影响判断变成待重评"后立即重评） */
export function reevaluateAllCurrent(): void {
  for (const message of listMessages()) {
    if (!message.currentRevisionId) continue;
    const revision = getRevision(message.currentRevisionId);
    if (revision) computeAndStoreDecision(message, revision);
  }
}

/** 纠正作用域 1：仅本条 —— 当前修订的分区覆盖，不改变兴趣或身份（F4） */
export function resolveThisRevision(
  messageId: string,
  partition: Partition,
  revisionId: string,
  expectedVersion?: number,
): "ok" | "not_found" | "conflict" {
  return getDb().transaction(() => {
  const message = getMessage(messageId);
  if (!message?.currentRevisionId) return "not_found";
  if (message.currentRevisionId !== revisionId) return 'conflict';
  const revision = getRevision(message.currentRevisionId)!;
  const existing = getDecisionByRevision(revision.id);
  if (expectedVersion !== undefined && existing?.version !== expectedVersion) return 'conflict';
  upsertDecision({
    messageId,
    revisionId: revision.id,
    applicability: existing?.applicability ?? null,
    basePartition: existing?.basePartition ?? "review",
    matchedRuleId: existing?.matchedRuleId ?? null,
    matchedRuleVersion: existing?.matchedRuleVersion ?? null,
    manualPartition: partition,
    partition,
  });
  return "ok";
  }).immediate();
}

/** 纠正作用域 2：更正身份 —— 修改主人确认事实并重评；不回写已确认任务 */
export function resolveProfile(
  facts: Array<{ field: string; value: string; expectedVersion: number }>,
): { updated: number; conflicts: string[] } | "invalid_field" {
  for (const f of facts) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(f.field)) return "invalid_field";
  }
  return getDb().transaction(() => {
    const conflicts = facts.filter((f) => (getFactByField(f.field)?.version ?? 0) !== f.expectedVersion).map((f) => f.field);
    if (conflicts.length) return { updated: 0, conflicts };
    for (const f of facts) upsertFact(f.field, f.value, f.expectedVersion);
    reevaluateAllCurrent();
    return { updated: facts.length, conflicts: [] };
  }).immediate();
}

/** 纠正作用域 3：保存规则 —— 结构化条件和输出，主人确认后启用并重评；可撤销（删除/停用） */
export function resolveRule(rule: {
  source: string;
  noticeType: string;
  condition: unknown;
  outputPartition: string;
  priority: number;
}): ProfileRuleRow {
  const parsed = profileRuleSchema.parse(rule);
  const created = createRule({
    source: parsed.source,
    noticeType: parsed.noticeType,
    condition: parsed.condition,
    outputPartition: parsed.outputPartition,
    priority: parsed.priority,
  });
  // resolve 路径是主人显式确认保存 → 直接启用（/profile-rules POST 创建的是未启用草稿）
  updateRule(created.id, { enabled: true }, created.version);
  reevaluateAllCurrent();
  return { ...created, enabled: true };
}

/**
 * 从行动草案创建正式任务并关联（F5：不复制、不覆盖）。
 * - 同 (message, actionKey) 已关联 → 返回既有任务 + 差异，不重复创建；
 * - 创建是主人显式动作；due 使用草案值或主人输入。
 */
export function createTaskFromAction(
  messageId: string,
  actionKey: string,
  taskInput?: { title?: string; due?: import("@/contracts/planning").Due },
):
  | { kind: "created"; taskId: string }
  | { kind: "exists"; taskId: string; diff: SourceChangeDiff[] }
  | { kind: "not_found" } {
  const message = getMessage(messageId);
  if (!message?.currentRevisionId) return { kind: "not_found" };
  const revision = getRevision(message.currentRevisionId)!;
  const action = revision.structured?.action;
  if (!action || action.actionKey !== actionKey) return { kind: "not_found" };

  const link = getTaskLink(messageId, actionKey);
  if (link) {
    // 已有任务：来源更新不覆盖、不复制；返回差异草案供主人人工编辑
    return { kind: "exists", taskId: link.taskId, diff: sourceChangeDiff(messageId) };
  }
  const task = createTask({
    title: taskInput?.title ?? action.title,
    description: action.description,
    projectId: null,
    goalId: null,
    status: "todo",
    priority: "normal",
    estimateMinutes: null,
    plannedWeek: null,
    scheduledStart: null,
    scheduledEnd: null,
    due: taskInput?.due ?? action.due ?? { kind: "none" },
  });
  createTaskLink({ messageId, actionKey, taskId: task.id, revisionId: revision.id });
  return { kind: "created", taskId: task.id };
}

export type SourceChangeDiff = {
  actionKey: string;
  taskId: string;
  changed: boolean;
  fields: Array<{ field: "title" | "due"; taskValue: string; draftValue: string }>;
};

/** 来源变化差异草案：比较当前修订的行动草案与已建任务（只标记，不覆盖） */
export function sourceChangeDiff(messageId: string): SourceChangeDiff[] {
  const message = getMessage(messageId);
  if (!message?.currentRevisionId) return [];
  const revision = getRevision(message.currentRevisionId)!;
  const action = revision.structured?.action;
  const diffs: SourceChangeDiff[] = [];
  for (const link of listTaskLinks(messageId)) {
    const task = getTask(link.taskId);
    if (!task) continue;
    const draft = action && action.actionKey === link.actionKey ? action : null;
    const fields: SourceChangeDiff["fields"] = [];
    if (draft) {
      if (draft.title !== task.title) {
        fields.push({ field: "title", taskValue: task.title, draftValue: draft.title });
      }
      const draftDue = draft.due ?? { kind: "none" as const };
      if (JSON.stringify(draftDue) !== JSON.stringify(task.due)) {
        fields.push({
          field: "due",
          taskValue: JSON.stringify(task.due),
          draftValue: JSON.stringify(draftDue),
        });
      }
    }
    // 比较关联时的修订与当前修订：来源正文变化也标记
    const linkedRevision = getRevision(link.revisionId);
    const changed = fields.length > 0 || linkedRevision?.id !== revision.id;
    diffs.push({ actionKey: link.actionKey, taskId: link.taskId, changed, fields });
  }
  return diffs;
}

/** 主人选择修订版本（revision_conflict 待选择后）；当前版需重评 */
export function selectRevision(messageId: string, revisionId: string): "ok" | "not_found" {
  const message = getMessage(messageId);
  if (!message) return "not_found";
  const revision = getRevision(revisionId);
  if (!revision || revision.messageId !== messageId) return "not_found";
  setMessageCurrent(messageId, revisionId, "active");
  const fresh = getMessage(messageId)!;
  computeAndStoreDecision(fresh, revision);
  return "ok";
}
import { getDb } from '@/repositories/db';
