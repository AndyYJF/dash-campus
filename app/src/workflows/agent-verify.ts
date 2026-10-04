import { getDb } from "@/repositories/db";
import { OPERATIONS, type Command } from "@/contracts/commands";
import { listChanges, type ChangeRow } from "@/repositories/journal";
import { listItems, type IntakeItemRow } from "@/repositories/intakes";
import type { CheckRecord, VerificationStatus } from "@/repositories/agent-runs";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { eventsForDay, latestPlanUnscheduled } from "@/workflows/plan";
import { batchChanges, entityLabel } from "@/workflows/results";

/**
 * 执行后核验（Agent 方案 §5.2）：命令成功后重新读取当前事实，按操作注册表里的 verify 模板逐项判定。
 * 条件由服务端生成，模型不能把“命令返回 ok”当成达成；读不到、对不上、缺后续都如实记为未通过。
 * 只读不写：修正在 agent-run 里按授权范围做。
 */

export type IntakeVerification = { status: VerificationStatus; checks: CheckRecord[] };

const TABLE: Record<string, string> = {
  task: "tasks",
  plan_session: "plan_sessions",
  practice_entry: "practice_entries",
  project: "projects",
  goal: "goals",
  fixed_event: "fixed_events",
  policy_rule: "planning_policy_rules",
  planning_preferences: "planning_preferences",
  resource: "resources",
  candidate: "candidates",
  teaching_override: "teaching_day_overrides",
};
const ACTIVE_SESSION = ["tentative", "planned", "in_progress"];
const columnCache = new Map<string, Set<string>>();

function columns(table: string): Set<string> {
  let c = columnCache.get(table);
  if (!c) {
    c = new Set((getDb().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
    columnCache.set(table, c);
  }
  return c;
}

const snake = (k: string) => k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);

function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v ?? null);
}

function same(stored: unknown, expected: unknown): boolean {
  if (expected === undefined) return true;
  if (typeof expected === "boolean") return Number(stored) === (expected ? 1 : 0);
  if (expected === null) return stored === null || stored === undefined;
  return String(stored) === String(expected);
}

/** 一条变更现在还成立吗：对象在、状态与写入时一致；之后又被改过（后续步骤、重排或主人）的只核对存在 */
function changeHolds(c: ChangeRow): string | null {
  const table = TABLE[c.entityKind];
  if (!table) return null;
  const cols = columns(table);
  if (!cols.size) return null;
  const row = getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(c.entityId) as Record<string, unknown> | undefined;
  const label = entityLabel(c.entityKind, c.entityId);
  if (c.action === "delete") {
    if (!row) return null;
    const gone = row.archived_at || ["cancelled", "superseded", "archived", "revoked"].includes(String(row.status ?? ""));
    return gone ? null : `「${label}」应已移除，但仍然有效`;
  }
  if (!row) return `「${label}」写入后读不到了`;
  if (cols.has("version") && c.afterVersion !== null && Number(row.version) !== c.afterVersion) {
    return Number(row.version) > c.afterVersion ? null : `「${label}」版本与写入时不一致`;
  }
  for (const [k, v] of Object.entries(c.after ?? {})) {
    const col = snake(k);
    if (v !== null && typeof v === "object") {
      if (cols.has(`${col}_json`) && stable(JSON.parse(String(row[`${col}_json`] ?? "null"))) !== stable(v)) return `「${label}」的${k}与写入的不一致`;
      continue;
    }
    if (cols.has(col) && !same(row[col], v)) return `「${label}」的${k}现在是 ${String(row[col])}，不是写入的 ${String(v)}`;
  }
  return null;
}

type Batch = { id: string; command: string; status: string };

function batchesOfItem(itemId: string): Batch[] {
  return getDb().prepare(`SELECT id, command, status FROM agent_action_batches WHERE item_id = ? AND command != 'plan_sessions' ORDER BY created_at, rowid`).all(itemId) as Batch[];
}

function planFollowUp(item: IntakeItemRow): { state: string } | null {
  const f = ((item.payload.followUps as Array<{ kind: string; state: string }> | undefined) ?? []).find((x) => x.kind === "plan");
  return f ?? null;
}

/** 当天仍有效、尚未开始的学习块与课程/固定活动重叠（现查日历，不读缓存结论） */
function overlapsOn(dates: string[], now: Date, tz: string): Array<{ sessionId: string; taskId: string; title: string; date: string; locked: boolean }> {
  const db = getDb();
  const out: Array<{ sessionId: string; taskId: string; title: string; date: string; locked: boolean }> = [];
  for (const date of [...new Set(dates)].sort().slice(0, 14)) {
    const events = eventsForDay(date, tz).filter((e) => e.kind !== "pending");
    if (!events.length) continue;
    const rows = db.prepare(`SELECT s.id, s.task_id, s.start_utc, s.end_utc, s.locked, t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.status IN ('tentative','planned') AND s.start_utc > ?`).all(now.toISOString()) as Array<{ id: string; task_id: string; start_utc: string; end_utc: string; locked: number; title: string }>;
    for (const s of rows) {
      if (localDateInTz(new Date(s.start_utc), tz) !== date) continue;
      const [a, b] = [Date.parse(s.start_utc), Date.parse(s.end_utc)];
      const hit = events.find((e) => e.interval[0] < b && e.interval[1] > a);
      if (hit) out.push({ sessionId: s.id, taskId: s.task_id, title: `${s.title}（撞上「${hit.title}」）`, date, locked: s.locked === 1 });
    }
  }
  return out;
}

function openQuestionId(keyLike: string): string | null {
  return (getDb().prepare(`SELECT id FROM clarification_questions WHERE status = 'open' AND question_key LIKE ? ORDER BY created_at DESC LIMIT 1`).get(keyLike) as { id: string } | undefined)?.id ?? null;
}

function practiceDuplicates(batch: Batch, intakeId: string): string | null {
  const db = getDb();
  for (const c of listChanges(batch.id).filter((x) => x.entityKind === "practice_entry" && x.action === "create")) {
    const p = db.prepare(`SELECT occurred_on, actual_minutes, task_id FROM practice_entries WHERE id = ?`).get(c.entityId) as { occurred_on: string; actual_minutes: number | null; task_id: string | null } | undefined;
    if (!p) return "实践记录写入后读不到了";
    const twins = db.prepare(
      `SELECT COUNT(*) AS n FROM practice_entries p JOIN agent_action_changes ch ON ch.entity_id = p.id AND ch.entity_kind = 'practice_entry' AND ch.action = 'create'
       JOIN agent_action_batches b ON b.id = ch.batch_id AND b.status = 'applied' AND b.intake_id = ?
       WHERE p.id != ? AND p.occurred_on = ? AND p.actual_minutes IS ? AND p.task_id IS ?`,
    ).get(intakeId, c.entityId, p.occurred_on, p.actual_minutes, p.task_id) as { n: number };
    if (twins.n > 0) return `${p.occurred_on} 的 ${p.actual_minutes ?? "?"} 分钟在这次处理里被记了 ${twins.n + 1} 次`;
  }
  return null;
}

/** 一个已执行步骤的核验项 */
function verifyAppliedItem(intakeId: string, item: IntakeItemRow, now: Date, tz: string): CheckRecord[] {
  const checks: CheckRecord[] = [];
  const summary = String(item.payload.summary ?? "").slice(0, 60);
  const batches = batchesOfItem(item.id);
  const push = (kind: string, failure: string | null, okDetail: string, extra: Partial<CheckRecord> = {}) =>
    checks.push({ kind, ok: failure === null, itemId: item.id, subject: summary, detail: failure ?? okDetail, ...extra });

  if (item.payload.readOnly === true) {
    push("read_only", batches.length ? `只读回答却写了 ${batches.length} 个变更批次` : null, "只读，没有修改业务数据");
    return checks;
  }
  if (batches.length > 1) push("applied_once", `同一步写入了 ${batches.length} 次`, "");
  const applied = item.payload.applied as { batchId?: string | null; noChange?: boolean } | undefined;
  const batch = batches.find((b) => b.id === applied?.batchId) ?? batches[0];
  if (!batch) {
    push("entity_state_matches", null, applied?.noChange ? "原本就是这样，没有需要改的" : "没有产生业务变更");
    return checks;
  }
  if (batch.status === "undone") {
    push("entity_state_matches", null, "这一步之后已被撤销");
    return checks;
  }
  const meta = OPERATIONS[batch.command as Command["command"]];
  if (!meta) return checks;
  const changes = listChanges(batch.id);
  const dates = batchChanges(batch.id).dates;

  for (const kind of meta.verify) {
    if (kind === "entity_state_matches" || kind === "policy_saved") {
      const scoped = kind === "policy_saved" ? changes.filter((c) => ["policy_rule", "planning_preferences", "setting"].includes(c.entityKind)) : changes;
      const problem = scoped.slice(0, 40).map(changeHolds).find(Boolean) ?? null;
      push(kind, problem, kind === "policy_saved" ? "规则已保存并读回一致" : `已读回 ${Math.min(scoped.length, 40)} 处变更，状态一致`);
    } else if (kind === "session_in_scope") {
      const db = getDb();
      let problem: string | null = null;
      for (const c of changes.filter((x) => x.entityKind === "plan_session" && typeof x.after?.startUtc === "string")) {
        const s = db.prepare(`SELECT start_utc, end_utc, status FROM plan_sessions WHERE id = ?`).get(c.entityId) as { start_utc: string; end_utc: string; status: string } | undefined;
        if (!s || !ACTIVE_SESSION.includes(s.status) && s.status !== "completed") problem ??= "挪好的学习块已不在安排里";
        else if (s.start_utc !== c.after!.startUtc || s.end_utc !== c.after!.endUtc) problem ??= "学习块不在你要求的位置（之后被移动过）";
        else {
          const [a, b] = [Date.parse(s.start_utc), Date.parse(s.end_utc)];
          const hit = eventsForDay(localDateInTz(new Date(a), tz), tz).find((e) => e.kind !== "pending" && e.interval[0] < b && e.interval[1] > a);
          if (hit) problem ??= `学习块和「${hit.title}」重叠`;
        }
      }
      push(kind, problem, "学习块在要求的位置，不撞课程或固定活动");
    } else if (kind === "plan_consistent") {
      if (meta.affects.includes("plan")) {
        const follow = planFollowUp(item);
        if (!follow) push(kind, "学习安排没有随这次修改更新", "", { repair: "replan" });
        else if (follow.state === "failed") push(kind, "学习安排更新失败", "", { repair: "replan" });
        else push(kind, null, follow.state === "updated" ? "学习安排已随之更新" : "学习安排核对过，不需要变化");
      }
      // 暂停/完成/归档的任务：未开始的块必须已让出
      const closedTasks = changes.filter((c) => c.entityKind === "task" && (c.after?.pausedUntil || c.after?.status === "done" || c.after?.archivedAt)).map((c) => c.entityId);
      if (closedTasks.length) {
        const left = getDb().prepare(`SELECT COUNT(*) AS n FROM plan_sessions WHERE status IN ('tentative','planned') AND locked = 0 AND origin != 'user' AND task_id IN (${closedTasks.map(() => "?").join(",")})`).get(...closedTasks) as { n: number };
        push("entity_state_matches", left.n ? `暂停或结束的任务还有 ${left.n} 个未开始的学习块` : null, "暂停或结束的任务已让出未开始的学习块", left.n ? { repair: "replan" } : {});
      }
      // 课程、日程与安排类修改：涉及日期上不能留下与课程/固定活动重叠的未开始学习块
      if (["course", "calendar", "plan"].includes(meta.group)) {
        const hits = overlapsOn(dates, now, tz);
        if (hits.length) {
          const h = hits[0]!;
          const questionId = openQuestionId(`session.conflict:${h.sessionId}:%`);
          push(kind, `${h.date} ${h.title}${h.locked ? "，这段是你锁定的，没有擅自移动" : ""}${hits.length > 1 ? `，另有 ${hits.length - 1} 处` : ""}`, "", { repair: "replan", questionId });
        } else if (dates.length) push(kind, null, "涉及日期的学习块不撞课程或固定活动");
      }
    } else if (kind === "practice_not_duplicated") {
      push(kind, practiceDuplicates(batch, intakeId), "这次投入只记了一次");
    } else if (kind === "side_effect_status") {
      const mail = meta.sideEffects.includes("mail");
      push(kind, null, mail ? "已交给发送队列；是否送达不在这里核对，不会自动重发" : "已受理，后续结果在对应页面查看");
    }
  }
  return checks;
}

/** 这次处理涉及的任务里，截止前仍排不下的：要主人取舍，不自行改截止或预算 */
function demandChecks(intakeId: string): CheckRecord[] {
  const db = getDb();
  const taskIds = new Set<string>();
  const batches = db.prepare(`SELECT id FROM agent_action_batches WHERE intake_id = ? AND status = 'applied' AND command != 'plan_sessions'`).all(intakeId) as Array<{ id: string }>;
  for (const b of batches) {
    for (const c of listChanges(b.id)) {
      if (c.entityKind === "task") taskIds.add(c.entityId);
      if (c.entityKind === "plan_session") {
        const t = db.prepare(`SELECT task_id FROM plan_sessions WHERE id = ?`).get(c.entityId) as { task_id: string } | undefined;
        if (t) taskIds.add(t.task_id);
      }
    }
  }
  if (!taskIds.size) return [];
  return latestPlanUnscheduled()
    .filter((u) => u.reason === "deadline_unfeasible" && taskIds.has(u.taskId))
    .slice(0, 3)
    .map((u) => ({ kind: "demand_covered", ok: false, itemId: null, subject: u.title, detail: `截止前还缺 ${u.missingMinutes ?? "?"} 分钟；截止、课程和学习预算都没有改，需要你选怎么取舍`, questionId: openQuestionId(`task.deadline:${u.taskId}:%`) }));
}

/** 投递级核验：已执行步骤逐项读回 + 多步是否全部完成 + 涉及任务的需求是否排得下 */
export function verifyIntake(intakeId: string, now: Date): IntakeVerification | null {
  const tz = instanceTimezone();
  const items = listItems(intakeId).filter((i) => !["cancelled", "ignored"].includes(i.state) && !i.payload.goalStop && !i.payload.reply);
  const applied = items.filter((i) => i.state === "applied");
  if (!applied.length) return null;
  const checks: CheckRecord[] = applied.flatMap((i) => verifyAppliedItem(intakeId, i, now, tz));

  const steps = items.filter((i) => i.payload.stepKeys);
  const failed = items.filter((i) => i.state === "failed");
  if (steps.length > 1 || (failed.length && applied.length)) {
    const missing = (steps.length > 1 ? steps : items).filter((i) => i.state !== "applied" && i.state !== "ready");
    const waiting = missing.filter((i) => i.state === "awaiting_input");
    const broken = missing.filter((i) => i.state === "failed");
    const detail = broken.length
      ? broken.map((i) => `「${String(i.payload.summary ?? "").slice(0, 40)}」没有完成：${String(i.evidence?.error ?? "处理失败").slice(0, 120)}`).join("；")
      : waiting.length ? `还有 ${waiting.length} 步在等你回答` : "";
    checks.push({ kind: "dependent_steps_completed", ok: broken.length ? false : waiting.length ? null : true, itemId: null, subject: steps.length > 1 ? `${steps.length} 个步骤` : `${items.length} 项`, detail: detail || "各步骤都已完成" });
  }
  for (const i of failed) {
    if (i.evidence?.code === "STALE_VERSION" && !batchesOfItem(i.id).length) {
      checks.push({ kind: "entity_state_matches", ok: false, itemId: i.id, subject: String(i.payload.summary ?? "").slice(0, 60), detail: "执行时对象刚被改过，需要按最新状态重新绑定", repair: "rebind" });
    }
  }
  checks.push(...demandChecks(intakeId));

  const failing = checks.filter((c) => c.ok === false);
  const pending = checks.some((c) => c.ok === null) || items.some((i) => ["awaiting_input", "extracted", "resolving"].includes(i.state));
  const status: VerificationStatus = failing.some((c) => !c.questionId) ? "partial" : failing.length ? "needs_action" : pending ? "pending" : "verified";
  return { status, checks };
}
