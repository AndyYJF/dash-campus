import { getDb } from "@/repositories/db";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { PROFILE_FIELDS, type Partition } from "@/contracts/inbox";
import { normalizeProfileValue, PROFILE_LABEL, requiresValue } from "@/domain/identity";
import { getFactByField, upsertFact } from "@/repositories/profile";
import { getDecisionByRevision, getMessage, getRevision, getTaskLink } from "@/repositories/inbox";
import { getSetting } from "@/repositories/settings";
import { createTaskFromAction, reevaluateAllCurrent, resolveThisRevision } from "@/workflows/inbox";
import { HttpError } from "@/workflows/http";

/**
 * 身份与通知筛选操作（MASTER-PLAN §7，AGENT-INTERFACE-CONTRACT §2/§7）。
 * 身份只来自主人陈述；筛选规则只改变 Dash 里的展示和派生行动，来源原文一字不动、不回写 Todo；
 * 资格不明不默认过滤；重评估不会把已结束的旧通知变成新任务。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;
const now = () => new Date().toISOString();

export const NOTICE_FILTERS_KEY = "noticeFilters";
export type NoticeFilter = { field: string; value: string; evidence: string; createdAt: string };

export function noticeFilters(): NoticeFilter[] {
  return (getSetting(NOTICE_FILTERS_KEY).value as NoticeFilter[] | null) ?? [];
}

export function applyProfileFacts(cmd: Cmd<"update_profile_fact">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const parts: string[] = [];
  for (const f of cmd.facts) {
    if (!(PROFILE_FIELDS as readonly string[]).includes(f.field)) throw new HttpError(422, "VALIDATION", `不支持的身份字段 ${f.field}`);
    const value = normalizeProfileValue(f.field, f.value);
    const existing = getFactByField(f.field);
    if (existing?.value === value) continue;
    const row = upsertFact(f.field, value, existing?.version ?? 0);
    if (row === "conflict") throw new HttpError(409, "CONFLICT", "身份信息刚被修改，请重试");
    if (existing) changes.push({ entityKind: "profile_fact", entityId: existing.id, action: "update", before: { value: existing.value }, after: { value }, beforeVersion: existing.version, afterVersion: row.version });
    else changes.push({ entityKind: "profile_fact", entityId: row.id, action: "create", after: { field: f.field, value }, afterVersion: 1 });
    parts.push(`${PROFILE_LABEL[f.field as keyof typeof PROFILE_LABEL]}：${value}`);
  }
  if (!changes.length) return "身份信息没有变化";
  // 身份变了：还在处理中的通知按新身份重评；已建的任务不动
  reevaluateAllCurrent();
  return `已记下你的身份——${parts.join("，")}；待处理的通知按新身份重新判断`;
}

/** 有范围的筛选规则：某类人群专属的通知不进行动。只在主人身份还不明确时起作用——身份明确后本来就按身份判断 */
export function applyNoticeRule(cmd: Cmd<"upsert_notice_rule">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const entry = getSetting(NOTICE_FILTERS_KEY);
  const before = noticeFilters();
  const value = normalizeProfileValue(cmd.field, cmd.value);
  const exists = before.some((f) => f.field === cmd.field && f.value === value);
  const after = cmd.remove ? before.filter((f) => !(f.field === cmd.field && f.value === value)) : exists ? before : [...before, { field: cmd.field, value, evidence: ctx.evidence, createdAt: now() }];
  if (after.length === before.length && (cmd.remove ? true : exists)) return cmd.remove ? "没有这条筛选规则" : `${value}专属通知的筛选规则已经在了`;
  if (entry.version === 0) {
    db.prepare(`INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)`).run(NOTICE_FILTERS_KEY, JSON.stringify(after), now());
    changes.push({ entityKind: "setting", entityId: NOTICE_FILTERS_KEY, action: "create", after: { filters: after }, afterVersion: 1 });
  } else {
    db.prepare(`UPDATE settings SET value_json = ?, version = version + 1, updated_at = ? WHERE key = ?`).run(JSON.stringify(after), now(), NOTICE_FILTERS_KEY);
    changes.push({ entityKind: "setting", entityId: NOTICE_FILTERS_KEY, action: "update", before: { valueJson: JSON.stringify(before) }, after: { valueJson: JSON.stringify(after) }, beforeVersion: entry.version, afterVersion: entry.version + 1 });
  }
  return cmd.remove
    ? `已撤回“${value}专属通知不进行动”的规则；之前被它折叠的通知可以在收件箱里看到，新的通知不再按它筛`
    : `以后明确只面向${value}的通知只存资料、不进行动（原文都保留，可在收件箱查看被折叠的通知，也可以随时撤回这条规则）`;
}

const PARTITION_TEXT: Record<Partition, string> = { action: "需要你行动", info: "与你有关，仅供了解", opportunity: "可选机会，不占行动", review: "条件还不明确，先存为待判断", folded: "与你无关，已折叠保存" };

/** 这条通知（当前修订）对主人意味着什么；资格不明时命中筛选规则的折叠 */
export function noticeOutcome(messageId: string): { partition: Partition; reason: string; title: string; hasAction: boolean } | null {
  const message = getMessage(messageId);
  if (!message?.currentRevisionId) return null;
  const revision = getRevision(message.currentRevisionId)!;
  const decision = getDecisionByRevision(revision.id);
  let partition = (decision?.partition ?? "review") as Partition;
  let reason = "";
  const condition = revision.structured?.condition;
  if (partition === "review" && condition && !decision?.manualPartition) {
    const hit = noticeFilters().find((f) => requiresValue(condition, f.field, f.value));
    if (hit) {
      partition = "folded";
      reason = `按你的规则：只面向${hit.value}的通知不进行动`;
    }
  }
  if (!reason) {
    reason =
      decision?.manualPartition != null
        ? "你自己判断的"
        : decision?.applicability === "FALSE"
          ? "资格条件和你的身份不符"
          : decision?.applicability === "TRUE"
            ? "资格条件和你的身份相符"
            : condition
              ? "资格条件里有你还没告诉我的信息"
              : "通知没有写明适用对象";
  }
  return { partition, reason, title: revision.structured?.action?.title ?? revision.structured?.noticeType ?? "通知", hasAction: Boolean(revision.structured?.action) };
}

function createActionTask(messageId: string, changes: ChangeInput[]): string | null {
  const message = getMessage(messageId)!;
  const revision = getRevision(message.currentRevisionId!)!;
  const action = revision.structured?.action;
  if (!action) return null;
  const existing = getTaskLink(messageId, action.actionKey);
  if (existing) return null; // 已建过任务：来源更新不复制、不覆盖
  const r = createTaskFromAction(messageId, action.actionKey);
  if (r.kind !== "created") return null;
  changes.push({ entityKind: "task", entityId: r.taskId, action: "create", after: { title: action.title, fromNotice: messageId }, afterVersion: 1 });
  const link = getTaskLink(messageId, action.actionKey)!;
  changes.push({ entityKind: "inbox_task_link", entityId: link.id, action: "create", after: { messageId, taskId: r.taskId }, afterVersion: null });
  return r.taskId;
}

/** 通知落地：明确适用且必须做的 → 建任务（截止按原文）；其余只保留事实，不制造行动 */
export function applyNotice(cmd: Cmd<"apply_notice">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const outcome = noticeOutcome(cmd.messageId);
  if (!outcome) throw new HttpError(404, "NOT_FOUND", "这条通知不存在");
  if (outcome.partition === "action") {
    const taskId = createActionTask(cmd.messageId, changes);
    return taskId ? `通知里有你要做的事：已建任务「${outcome.title}」（${outcome.reason}）` : `「${outcome.title}」对应的任务之前已经建过，没有重复创建`;
  }
  return `「${outcome.title}」${PARTITION_TEXT[outcome.partition]}（${outcome.reason}）；原文已保存`;
}

/** 主人纠正这一条通知的归类（“这不是我的任务”“这条我要做”）：只影响这条的当前版本，不改身份和规则 */
export function applyResolveNotice(cmd: Cmd<"resolve_notice">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const message = getMessage(cmd.messageId);
  if (!message?.currentRevisionId) throw new HttpError(404, "NOT_FOUND", "这条通知不存在");
  const before = getDecisionByRevision(message.currentRevisionId);
  if (before?.partition === cmd.partition) return "这条通知已经是这个归类";
  const r = resolveThisRevision(cmd.messageId, cmd.partition, message.currentRevisionId);
  if (r !== "ok") throw new HttpError(409, "CONFLICT", "通知刚有新版本，请按最新内容再判断");
  const after = getDecisionByRevision(message.currentRevisionId)!;
  changes.push({ entityKind: "inbox_decision", entityId: after.id, action: "update", before: { partition: before?.partition ?? "review", manualPartition: before?.manualPartition ?? null }, after: { partition: cmd.partition, manualPartition: cmd.partition }, beforeVersion: before?.version ?? null, afterVersion: after.version });
  let extra = "";
  if (cmd.partition === "action") {
    const taskId = createActionTask(cmd.messageId, changes);
    if (taskId) extra = "，并建了对应任务";
  } else {
    // 改判为不用做：已建的任务不替主人删除，只说明还在
    const link = getDb().prepare(`SELECT task_id FROM inbox_task_links WHERE message_id = ?`).get(cmd.messageId) as { task_id: string } | undefined;
    if (link) extra = "；之前建的任务还在，不需要的话说一声我来归档";
  }
  return `这条通知改为：${PARTITION_TEXT[cmd.partition]}${extra}。来源原文没有改动`;
}
