import { getDb } from "@/repositories/db";
import { addDays, instanceTimezone, localDateInTz, tzOffsetMs } from "@/domain/time";
import { dayClassOf, describeConstraint, protectingConstraint, type ConstraintValue } from "@/domain/constraints";
import { commandEntities, hashOf } from "./command-facts";

/**
 * 统一约束与授权门（语义修复 W2/R01/R04）：所有入口（直接执行、决策、回答、按钮、恢复、修正）绑定出的命令
 * 在执行前都过这一道。按主人说过的范围与保护约束核对：
 * - 范围外的重排/不学/当日上限：拒绝（不扩大授权）；
 * - 受保护的日子/对象：能确定地收窄就收窄（只改工作日模板、去掉周末日期），并在结果里如实说明；收窄不了就拒绝；
 * - “几点后不排”：编译成范围内的临时不学时段；
 * - 受保护日子的学习块在随后的重排里冻结（不删不加）。
 * 只做减法与主人明说过的限制，不替主人扩大任何修改。
 */

export type GateContext = {
  today: string;
  /** 这件事的日期范围（主人明说的，或沿用同一目标上一版的） */
  scope: { dateFrom: string; dateTo: string } | null;
  /** 主人明说、带原话引用的范围（date_scope 约束）：具体学习块的新增与挪动也不能越出 */
  statedScope?: { dateFrom: string; dateTo: string } | null;
  constraints: ConstraintValue[];
};

export type GateResult =
  | { kind: "pass"; command: Record<string, unknown>; replanDates: string[]; frozenDates: string[]; frozenTaskIds: string[]; notes: string[] }
  | { kind: "reject"; reason: string };

/** 授权范围与保护约束的指纹：进入确认指纹，约束变了旧确认作废 */
export function gateKey(ctx: GateContext): string {
  return hashOf({ s: ctx.scope, c: ctx.constraints, ...(ctx.statedScope ? { ss: ctx.statedScope } : {}) });
}

const ALL_DAY_BASE = ["dailyLimitMinutes", "minBlockMinutes", "bufferPercent", "commuteMinutes", "meals"];
const RANGE_RULES = ["auto_reschedule", "no_study", "date_limit"];
const MAX_RULES = 10;

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}

function segments(dates: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const d of [...dates].sort()) {
    const last = out.at(-1);
    if (last && addDays(last[1], 1) === d) last[1] = d;
    else out.push([d, d]);
  }
  return out;
}

const protections = (ctx: GateContext) => ctx.constraints.filter((c) => c.kind === "protect_days" || c.kind === "protect_dates");

/** 未来 31 天里受保护的日子（重排时冻结） */
export function frozenDatesFor(ctx: GateContext): string[] {
  if (!protections(ctx).length) return [];
  return datesBetween(ctx.today, addDays(ctx.today, 30)).filter((d) => protectingConstraint(d, ctx.constraints));
}

/** 受保护对象（按名称或 ID）对应的任务 */
export function frozenTaskIdsFor(ctx: GateContext): string[] {
  const db = getDb();
  const ids = new Set<string>();
  for (const c of ctx.constraints) {
    if (c.kind !== "protect_entity") continue;
    const ref = c.ref;
    if (ref.kind === "id") {
      if (ref.entityKind === "task") ids.add(ref.id);
      if (ref.entityKind === "plan_session") {
        const s = db.prepare(`SELECT task_id FROM plan_sessions WHERE id = ?`).get(ref.id) as { task_id: string } | undefined;
        if (s) ids.add(s.task_id);
      }
    } else if (ref.kind === "named") {
      const text = ref.text.trim();
      if (text.length < 2) continue;
      for (const t of db.prepare(`SELECT id, title FROM tasks WHERE archived_at IS NULL`).all() as Array<{ id: string; title: string }>) {
        if (t.title.includes(text) || (t.title.length >= 2 && text.includes(t.title))) ids.add(t.id);
      }
    }
  }
  return [...ids];
}

function sessionInfo(id: unknown): { date: string; taskId: string } | null {
  if (typeof id !== "string") return null;
  const s = getDb().prepare(`SELECT start_utc, task_id FROM plan_sessions WHERE id = ?`).get(id) as { start_utc: string; task_id: string } | undefined;
  return s ? { date: localDateInTz(new Date(s.start_utc), instanceTimezone()), taskId: s.task_id } : null;
}

/** 命令点名的对象里有没有主人说过不动的：任务按 ID/名称，其他对象按 ID */
function protectedEntityHit(command: Record<string, unknown>, ctx: GateContext, frozenTaskIds: string[]): ConstraintValue | null {
  const ents = commandEntities(command);
  for (const c of ctx.constraints) {
    if (c.kind !== "protect_entity") continue;
    for (const e of ents) {
      if (e.kind === "task" && frozenTaskIds.includes(e.id)) return c;
      if (c.ref.kind === "id" && c.ref.entityKind === e.kind && c.ref.id === e.id) return c;
      if (c.ref.kind === "named" && e.kind !== "task" && c.ref.text.trim().length >= 2) {
        const row = getDb().prepare(`SELECT * FROM ${e.table} WHERE id = ?`).get(e.id) as { title?: string; name?: string } | undefined;
        const t = row?.title ?? row?.name ?? "";
        if (t && (t.includes(c.ref.text.trim()) || c.ref.text.includes(t))) return c;
      }
    }
  }
  return null;
}

const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const toHm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** 学习块现在的位置（本地日期、起止分钟；跨零点的结束按当天 24:00 之后计） */
function sessionPlace(id: unknown): { date: string; start: number; end: number } | null {
  if (typeof id !== "string") return null;
  const s = getDb().prepare(`SELECT start_utc, end_utc FROM plan_sessions WHERE id = ?`).get(id) as { start_utc: string; end_utc: string } | undefined;
  if (!s) return null;
  const tz = instanceTimezone();
  const at = new Date(s.start_utc);
  const local = new Date(at.getTime() + tzOffsetMs(at, tz)).toISOString();
  const start = toMin(local.slice(11, 16));
  return { date: localDateInTz(at, tz), start, end: start + Math.round((Date.parse(s.end_utc) - at.getTime()) / 60_000) };
}

/**
 * 具体学习块这一步实际占用的位置：新增的块、挪动前后、改时长后的块。
 * 起止不确定（只说挪到哪天、由排程找空档）的只给日期，收工时间留给执行后核验读回。
 */
export function blockPlacements(command: Record<string, unknown>): Array<{ date: string; start: number | null; end: number | null; moving: "new" | "from" | "to" }> {
  if (command.command === "schedule_session" && typeof command.date === "string" && typeof command.startLocalTime === "string") {
    const start = toMin(command.startLocalTime);
    return [{ date: command.date, start, end: start + Number(command.durationMinutes ?? 0), moving: "new" }];
  }
  if (command.command !== "reschedule_session") return [];
  const s = sessionPlace(command.sessionId);
  if (!s) return [];
  const date = typeof command.targetDate === "string" ? command.targetDate : s.date;
  const minutes = typeof command.durationMinutes === "number" ? command.durationMinutes : s.end - s.start;
  const inPlace = typeof command.targetDate !== "string" && (command.part ?? "any") === "any";
  const start = typeof command.startLocalTime === "string" ? toMin(command.startLocalTime) : inPlace ? s.start : null;
  return [{ ...s, moving: "from" }, { date, start, end: start === null ? null : start + minutes, moving: "to" }];
}

/** 主人说过的范围与“几点后不排”：具体学习块越界就拒绝（不擅自换成别的时间） */
function placementProblem(command: Record<string, unknown>, ctx: GateContext): string | null {
  const stated = ctx.statedScope;
  for (const p of blockPlacements(command)) {
    if (stated && (p.date < stated.dateFrom || p.date > stated.dateTo)) {
      const range = stated.dateFrom === stated.dateTo ? stated.dateFrom : `${stated.dateFrom} 至 ${stated.dateTo}`;
      return `这一步会${p.moving === "from" ? "动到" : "把学习排到"} ${p.date}，超出了你说的范围（${range}），没有执行`;
    }
    if (p.moving === "from" || p.end === null || p.start === null) continue;
    const inScope = !ctx.scope || (ctx.scope.dateFrom <= p.date && p.date <= ctx.scope.dateTo);
    for (const c of ctx.constraints) {
      if (c.kind !== "no_study_after" || !inScope || (c.days !== "all" && dayClassOf(p.date) !== c.days)) continue;
      if (p.end > toMin(c.time)) return `这一步把学习排到 ${p.date} ${toHm(p.start)}–${toHm(Math.min(p.end, 24 * 60 - 1))}，你说过“${quote(c)}”，没有执行`;
    }
  }
  return null;
}

/** 已落库的学习块是否仍满足这些条件（核验读回用；不满足返回原因） */
export function sessionConditionProblem(sessionId: string, ctx: GateContext): string | null {
  const s = sessionPlace(sessionId);
  if (!s) return null;
  return placementProblem({ command: "schedule_session", date: s.date, startLocalTime: toHm(s.start), durationMinutes: s.end - s.start }, ctx)?.replace(/^这一步/, "这个学习块").replace(/，没有执行$/, "") ?? null;
}

function ruleTouchesProtected(rule: { kind: string; weekday?: number | null; dateFrom?: string | null; dateTo?: string | null; value?: Record<string, unknown> }, ctx: GateContext): boolean {
  if (rule.dateFrom && rule.dateTo) return datesBetween(rule.dateFrom, rule.dateTo).some((d) => protectingConstraint(d, ctx.constraints));
  if (rule.kind === "group_limit") return ctx.constraints.some((c) => c.kind === "protect_days" && c.days === rule.value?.group);
  if (rule.kind === "weekday_limit" && rule.weekday) return ctx.constraints.some((c) => c.kind === "protect_days" && c.days === (rule.weekday! >= 6 ? "weekend" : "workday"));
  if (rule.kind === "preferred_window") return rule.value?.part === "weekend" && ctx.constraints.some((c) => c.kind === "protect_days" && c.days === "weekend");
  return false;
}

const quote = (c: ConstraintValue) => describeConstraint(c);

/** 一条绑定好的命令过门：通过（可能已收窄，附说明）或拒绝（附原因） */
export function gateCommand(command: Record<string, unknown>, replanDates: string[], ctx: GateContext): GateResult {
  const notes: string[] = [];
  const scope = ctx.scope;
  const prot = protections(ctx);
  const outside = (d: string) => Boolean(scope && (d < scope.dateFrom || d > scope.dateTo));
  const frozenDates = frozenDatesFor(ctx);
  const frozenTaskIds = frozenTaskIdsFor(ctx);
  const scopeText = scope ? (scope.dateFrom === scope.dateTo ? scope.dateFrom : `${scope.dateFrom} 至 ${scope.dateTo}`) : "";

  const name = String(command.command);
  // 范围约束的是“重新安排”授权本身；挪动/改固定活动连带的重排日期是结果，不是扩大授权
  if (name === "update_planning_policy" && replanDates.some(outside)) {
    const out = replanDates.filter(outside);
    return { kind: "reject", reason: `方案要重新安排 ${out[0]}${out.length > 1 ? ` 等 ${out.length} 天` : ""}，超出了你说的范围（${scopeText}），没有执行` };
  }
  let dates = replanDates;
  const kept = dates.filter((d) => !protectingConstraint(d, ctx.constraints));
  if (kept.length !== dates.length) {
    const c = protectingConstraint(dates.find((d) => protectingConstraint(d, ctx.constraints))!, ctx.constraints)!;
    notes.push(`按你说的“${quote(c)}”，${dates.length - kept.length} 天不重新安排`);
    dates = kept;
  }

  if (name === "update_planning_policy") {
    const base = { ...((command.base as Record<string, unknown> | undefined) ?? {}) };
    for (const c of prot) {
      if (c.kind !== "protect_days") continue;
      const keys = c.days === "weekend" ? ["weekendStart", "weekendEnd"] : ["workdayStart", "workdayEnd"];
      const dropped = keys.filter((k) => k in base);
      if (dropped.length) {
        for (const k of dropped) delete base[k];
        notes.push(`${c.days === "weekend" ? "周末" : "工作日"}作息保持原样（你说过“${c.days === "weekend" ? "周末" : "工作日"}不动”）`);
      }
    }
    const allDay = ALL_DAY_BASE.filter((k) => k in base);
    if (prot.length && allDay.length) return { kind: "reject", reason: `这个方案会改每天都生效的设置（${allDay.join("、")}），会连带改到你说不动的日子（${prot.map(quote).join("；")}）；没有执行。可以说只改工作日或只改周末的上限` };

    const rules: Array<Record<string, unknown>> = [];
    for (const raw of (command.rules as Array<Record<string, unknown>> | undefined) ?? []) {
      const r = raw as { kind: string; dateFrom?: string | null; dateTo?: string | null; weekday?: number | null; value?: Record<string, unknown> };
      if (r.dateFrom && r.dateTo) {
        const span = datesBetween(r.dateFrom, r.dateTo);
        if (scope && RANGE_RULES.includes(r.kind) && span.some(outside)) return { kind: "reject", reason: `方案里的时间规则涉及 ${r.dateFrom}${r.dateTo !== r.dateFrom ? ` 至 ${r.dateTo}` : ""}，超出了你说的范围（${scopeText}），没有执行` };
        const allowed = span.filter((d) => !protectingConstraint(d, ctx.constraints));
        if (allowed.length !== span.length) notes.push(`时间规则避开了受保护的 ${span.length - allowed.length} 天`);
        for (const [from, to] of segments(allowed)) rules.push({ ...raw, dateFrom: from, dateTo: to });
        continue;
      }
      if (ruleTouchesProtected(r, ctx)) {
        notes.push(`没有加入会影响受保护日子的长期规则（${r.kind}）`);
        continue;
      }
      rules.push(raw);
    }
    const revokeRuleIds = ((command.revokeRuleIds as string[] | undefined) ?? []).filter((id) => {
      const row = getDb().prepare(`SELECT kind, weekday, date_from, date_to, value_json FROM planning_policy_rules WHERE id = ?`).get(id) as { kind: string; weekday: number | null; date_from: string | null; date_to: string | null; value_json: string } | undefined;
      if (!row) return true;
      const touches = ruleTouchesProtected({ kind: row.kind, weekday: row.weekday, dateFrom: row.date_from, dateTo: row.date_to, value: JSON.parse(row.value_json) as Record<string, unknown> }, ctx);
      if (touches) notes.push("没有撤回作用于受保护日子的规则");
      return !touches;
    });
    // 主人说过的“几点后不排”：在这件事的范围内编译成临时不学时段（只限制，不扩大）
    for (const c of ctx.constraints) {
      if (c.kind !== "no_study_after") continue;
      const span = dates.length ? dates : scope ? datesBetween(scope.dateFrom, scope.dateTo) : datesBetween(ctx.today, addDays(ctx.today, 6));
      const target = span.filter((d) => d >= ctx.today && !protectingConstraint(d, ctx.constraints) && (c.days === "all" || dayClassOf(d) === c.days));
      for (const [from, to] of segments(target)) {
        if (rules.some((r) => r.kind === "no_study" && r.dateFrom === from && r.dateTo === to)) continue;
        rules.push({ kind: "no_study", dateFrom: from, dateTo: to, scope: "temporary", value: { fromTime: c.time, label: `${c.time} 后不排` } });
      }
      if (target.length) notes.push(`按你说的“${quote(c)}”，范围内 ${c.time} 之后不安排学习`);
    }
    if (rules.length > MAX_RULES) return { kind: "reject", reason: "按你的条件拆开后规则太多（超过 10 条），没有执行；可以把范围说得集中一些" };
    const next: Record<string, unknown> = { ...command, rules, revokeRuleIds };
    if (Object.keys(base).length) next.base = base;
    else delete next.base;
    const hadWork = Object.keys((command.base as Record<string, unknown> | undefined) ?? {}).length > 0 || ((command.rules as unknown[] | undefined) ?? []).length > 0 || ((command.revokeRuleIds as unknown[] | undefined) ?? []).length > 0 || replanDates.length > 0;
    // 只有约束把原本要做的事全部裁掉时才拒绝；本来就只确认模板等的命令照常通过
    if (hadWork && !Object.keys(base).length && !rules.length && !revokeRuleIds.length && !dates.length) {
      return { kind: "reject", reason: `按你说的“${(prot.length ? prot : ctx.constraints).map(quote).join("；")}”，这个方案没有剩下可以做的部分，没有执行` };
    }
    return { kind: "pass", command: next, replanDates: dates, frozenDates, frozenTaskIds, notes };
  }

  // 具体学习块与对象：落在受保护的日子或对象上就拒绝（不擅自改成别的块）
  const touched: Array<{ date?: string; taskId?: string }> = [];
  if (name === "schedule_session") touched.push({ date: String(command.date), ...(typeof command.taskId === "string" ? { taskId: command.taskId } : {}) });
  if (name === "reschedule_session" || name === "set_session_state") {
    const s = sessionInfo(command.sessionId);
    if (s) touched.push(s);
    if (typeof command.targetDate === "string") touched.push({ date: command.targetDate });
  }
  for (const field of ["taskId"]) if (typeof command[field] === "string") touched.push({ taskId: command[field] as string });
  for (const t of touched) {
    const c = t.date ? protectingConstraint(t.date, ctx.constraints) : null;
    if (c) return { kind: "reject", reason: `这一步会动到 ${t.date}，你说过“${quote(c)}”，没有执行` };
    if (t.taskId && frozenTaskIds.includes(t.taskId)) {
      const ent = ctx.constraints.find((x) => x.kind === "protect_entity")!;
      return { kind: "reject", reason: `这一步会动到你说过不动的对象（${quote(ent)}），没有执行` };
    }
  }
  // 按对象身份（注册表里的对象字段，含归档的 entityKind/entityId）核对“这个别动”
  const hit = protectedEntityHit(command, ctx, frozenTaskIds);
  if (hit) return { kind: "reject", reason: `这一步会动到你说过不动的对象（${quote(hit)}），没有执行` };
  const placed = placementProblem(command, ctx);
  if (placed) return { kind: "reject", reason: placed };
  return { kind: "pass", command, replanDates: dates, frozenDates, frozenTaskIds, notes };
}

/** 受保护部分的事实指纹：执行前记下，核验时对比（保护的日子、规则、学习块与对象都没被这次处理改动） */
export function protectedSnapshot(ctx: GateContext): string | null {
  const frozen = frozenDatesFor(ctx);
  const tasks = frozenTaskIdsFor(ctx);
  if (!frozen.length && !tasks.length) return null;
  const db = getDb();
  const tz = instanceTimezone();
  const prefs = db.prepare(`SELECT workday_start, workday_end, weekend_start, weekend_end FROM planning_preferences WHERE id = 1`).get() as Record<string, string>;
  const classes = new Set(ctx.constraints.flatMap((c) => (c.kind === "protect_days" ? [c.days] : [])));
  const rules = (db.prepare(`SELECT id, kind, weekday, date_from, date_to, value_json, status FROM planning_policy_rules WHERE status = 'active' ORDER BY id`).all() as Array<{ id: string; kind: string; weekday: number | null; date_from: string | null; date_to: string | null; value_json: string }>)
    .filter((r) => ruleTouchesProtected({ kind: r.kind, weekday: r.weekday, dateFrom: r.date_from, dateTo: r.date_to, value: JSON.parse(r.value_json) as Record<string, unknown> }, ctx))
    .map((r) => r.id);
  const sessions = (db.prepare(`SELECT id, task_id, start_utc, end_utc, status FROM plan_sessions WHERE status IN ('tentative','planned','in_progress') ORDER BY id`).all() as Array<{ id: string; task_id: string; start_utc: string; end_utc: string; status: string }>)
    .filter((s) => frozen.includes(localDateInTz(new Date(s.start_utc), tz)) || tasks.includes(s.task_id));
  return hashOf({
    prefs: { ...(classes.has("weekend") ? { ws: prefs.weekend_start, we: prefs.weekend_end } : {}), ...(classes.has("workday") ? { ds: prefs.workday_start, de: prefs.workday_end } : {}) },
    rules,
    sessions,
  });
}