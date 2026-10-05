import { getDb } from "@/repositories/db";
import { OPERATIONS, type Command } from "@/contracts/commands";
import { listChanges, type ChangeRow } from "@/repositories/journal";
import { getIntake, listItems, type IntakeItemRow } from "@/repositories/intakes";
import { listGoalConstraints } from "@/repositories/goal-constraints";
import type { CheckRecord, VerificationStatus } from "@/repositories/agent-runs";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { eventsForDay, latestPlanUnscheduled } from "@/workflows/plan";
import { batchChanges, entityLabel } from "@/workflows/results";
import { stepEffects } from "@/repositories/step-executions";
import { protectedSnapshot, sessionConditionProblem, type GateContext } from "@/workflows/agent-gate";

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
  direction_profile: "direction_profile",
  direction_track: "direction_tracks",
  roadmap_item: "roadmap_items",
  direction_project_link: "direction_project_links",
  direction_reflection: "direction_reflections",
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

function protectedNow(item: IntakeItemRow): string | null {
  const ctx = (item.payload.gate as { ctx?: GateContext } | undefined)?.ctx;
  return ctx ? protectedSnapshot(ctx) : null;
}

/** 目标上现在生效的范围与“几点后不排”（这一步照做过的沿用保护除外）；没有这类条件返回 null */
function goalConditions(intakeId: string, item: IntakeItemRow): GateContext | null {
  const goalId = getIntake(intakeId)?.goalId;
  if (!goalId) return null;
  const values = listGoalConstraints(goalId).filter((c) => !(item.payload.overrideInherited === true && c.source === "inherited")).map((c) => c.value);
  const stated = values.find((v): v is Extract<typeof v, { kind: "date_scope" }> => v.kind === "date_scope");
  const constraints = values.filter((v) => v.kind !== "date_scope");
  if (!stated && !constraints.some((v) => v.kind === "no_study_after")) return null;
  const ran = (item.payload.gate as { ctx?: GateContext } | undefined)?.ctx;
  return { today: ran?.today ?? "", scope: ran?.scope ?? null, statedScope: stated ? { dateFrom: stated.dateFrom, dateTo: stated.dateTo } : null, constraints };
}

const JOB_WAIT: Record<string, string> = { queued: "还在排队", running: "正在进行" };

/**
 * 异步/外部结果的真实状态：排队/进行中 = 等待（不算通过，也不算失败）；完成看结果；失败如实记。
 * 邮件：服务器接收不等于进收件箱；结果不确定的不自动重发，也不算通过。
 */
function effectChecks(item: IntakeItemRow, effects: Array<{ kind: string; id: string }>, subject: string, mail: boolean): CheckRecord[] {
  const db = getDb();
  const out: CheckRecord[] = [];
  const add = (ok: boolean | null, detail: string) => out.push({ kind: "side_effect_status", ok, itemId: item.id, subject, detail });
  const job = (id: string) => db.prepare(`SELECT status, result_json, last_error FROM jobs WHERE id = ?`).get(id) as { status: string; result_json: string | null; last_error: string | null } | undefined;
  const domain = effects.filter((e) => e.kind !== "job");
  for (const e of domain) {
    if (e.kind === "exploration_run") {
      const r = db.prepare(`SELECT status, error_message, job_id FROM exploration_runs WHERE id = ?`).get(e.id) as { status: string; error_message: string | null; job_id: string | null } | undefined;
      if (!r) add(false, "探索记录找不到了");
      else if (r.status === "done") add(true, "找候选项目已完成，结果在「方向」页");
      else if (r.status === "failed" || r.status === "cancelled") add(false, `找候选项目没有完成：${r.error_message ?? (r.status === "cancelled" ? "已取消" : "失败")}`);
      else {
        const j = r.job_id ? job(r.job_id) : undefined;
        if (j && ["failed", "cancelled"].includes(j.status)) add(false, `找候选项目的任务已结束但没有结果：${j.last_error ?? j.status}`);
        else add(null, `找候选项目${r.status === "queued" ? "还在排队" : "正在进行"}，完成后会自动再核对`);
      }
    } else if (e.kind === "review") {
      const r = db.prepare(`SELECT status, job_id FROM reviews WHERE id = ?`).get(e.id) as { status: string; job_id: string | null } | undefined;
      if (!r) add(false, "复盘记录找不到了");
      else if (r.status === "ready") add(true, "复盘已生成，在「复盘」页");
      else if (r.status === "insufficient") add(true, "这一周记录太少，复盘只列了已有事实");
      else if (r.status === "failed" || r.status === "cancelled") add(false, `复盘没有生成：${r.status === "cancelled" ? "已取消" : "生成失败"}`);
      else {
        const j = r.job_id ? job(r.job_id) : undefined;
        if (j && ["failed", "cancelled"].includes(j.status)) add(false, `复盘任务已结束但没有结果：${j.last_error ?? j.status}`);
        else add(null, `复盘${r.status === "queued" ? "还在排队" : "正在生成"}，完成后会自动再核对`);
      }
    } else if (e.kind === "export") {
      const r = db.prepare(`SELECT status, private_path FROM exports WHERE id = ?`).get(e.id) as { status: string; private_path: string | null } | undefined;
      add(r?.status === "ready" && r.private_path ? true : false, r?.status === "ready" ? "导出文件已生成，可下载" : `导出文件不可用（${r?.status ?? "找不到记录"}）`);
    }
  }
  if (!domain.length) {
    for (const e of effects.filter((x) => x.kind === "job")) {
      const j = job(e.id);
      if (!j) add(false, "后台任务找不到了");
      else if (JOB_WAIT[j.status]) add(null, `${mail ? "邮件" : "后台任务"}${JOB_WAIT[j.status]}，完成后会自动再核对`);
      else if (j.status === "failed" || j.status === "cancelled") add(false, `${mail ? "邮件没有发出" : "后台任务失败"}：${j.last_error ?? j.status}`);
      else {
        const result = j.result_json ? (JSON.parse(j.result_json) as { kind?: string; reason?: string }) : {};
        if (!mail || result.kind === "sent") add(true, mail ? "邮件服务器已接收（不等于已进收件箱；发出后不能撤回）" : "后台任务已完成");
        else if (result.kind === "unknown") add(false, "发送结果不确定，不会自动重发；可在「通知」页查看");
        else add(false, `没有发送：${result.reason ?? result.kind ?? "被跳过"}`);
      }
    }
  }
  return out;
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
  const command = String((item.payload.command as { command?: string } | undefined)?.command ?? "");
  // 主人说过不动的部分：执行前后的事实指纹必须一致（周末作息/规则/学习块、受保护对象）
  const guarded = item.payload.gate as { protectedBefore?: string | null } | undefined;
  if (guarded?.protectedBefore) {
    const now2 = protectedNow(item);
    push("constraints_hold", now2 !== guarded.protectedBefore ? "你说过不动的部分（日子、规则或安排）被这次处理改动了" : null, "你说过不动的部分没有被改动");
  }
  // 主人说过的范围与“几点后不排”：从目标上现在生效的约束读回，核对这一步写下的学习块（不只是核对执行符合模型参数）
  const conditions = goalConditions(intakeId, item);
  if (conditions && batch && batch.status !== "undone") {
    let problem: string | null = null;
    let seen = 0;
    for (const c of listChanges(batch.id).filter((x) => x.entityKind === "plan_session" && typeof x.after?.startUtc === "string")) {
      const s = getDb().prepare(`SELECT start_utc, status FROM plan_sessions WHERE id = ?`).get(c.entityId) as { start_utc: string; status: string } | undefined;
      if (!s || !ACTIVE_SESSION.includes(s.status) || s.start_utc !== c.after!.startUtc) continue;
      seen++;
      problem ??= sessionConditionProblem(c.entityId, conditions);
    }
    if (seen) push("goal_conditions_hold", problem, "学习块在你说的范围和时间内");
  }
  // 异步/外部结果：按执行凭据里的任务、探索、复盘、导出的真实状态判断，不把“已受理”当成完成
  const effects = stepEffects(item.id);
  if (effects.length) checks.push(...effectChecks(item, effects, summary, OPERATIONS[command as Command["command"]]?.sideEffects.includes("mail") ?? false));
  if (!batch) {
    // 没有业务批次不等于达成：必需的后续（主人要求的重排）失败或缺失也算没完成
    const follow = planFollowUp(item);
    const required = ((item.payload.replanDates as string[] | undefined) ?? []).length > 0 || Boolean(follow);
    if (follow?.state === "failed") push("plan_consistent", "要求的学习安排更新失败", "", { repair: "replan" });
    else if (required && !follow && command === "update_planning_policy") push("plan_consistent", "要求的学习安排没有更新", "", { repair: "replan" });
    else if (!effects.length) push("entity_state_matches", null, applied?.noChange ? "原本就是这样，没有需要改的" : "没有产生业务变更");
    if (follow && follow.state !== "failed") push("plan_consistent", null, follow.state === "updated" ? "学习安排已按要求更新" : "学习安排核对过，不需要变化");
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
    } else if (kind === "side_effect_status" && !effects.length) {
      // 有执行凭据的已在上面按真实状态核对；这里只剩没有外部结果的设置类操作
      push(kind, null, meta.sideEffects.includes("mail") ? "已交给发送队列；是否送达不在这里核对，不会自动重发" : "设置已保存");
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
