import { getDb } from "@/repositories/db";
import { answerReadRequest, type ReadLink } from "./read-answer";
import { pendingTasks, taskAdmitted } from "@/repositories/task-admission";
import { supersedeQuestion } from "@/repositories/questions";
import type { Intent, Ref } from "@/domain/intent";
import { parseInstruction } from "@/domain/intent";
import { estimateFromText, isCompletionReport, matchTask, parseNumber, type TaskRef } from "@/domain/task-text";
import { addDays, localDateInTz, wallTimeToUtc } from "@/domain/time";
import { isoWeekday } from "@/domain/day-policy";
import { nowDate } from "@/domain/clock";
import { agentTurnsBefore, type EntityRef } from "@/repositories/conversations";
import { activePolicyRules } from "@/repositories/calendar-facts";
import { getBatch } from "@/repositories/journal";
import { getPrefs, getSession } from "@/repositories/plan";
import { ensureOpenQuestion, listOpenQuestions, questionEverAsked, type QuestionRow } from "@/repositories/questions";
import { calendarDay } from "@/workflows/calendar";
import { awaitingFeedbackSessions, taskRemainingDemand, type RebuildResult } from "@/workflows/plan";
import { noticeFilters } from "@/workflows/ops/notices";
import { reminderPolicy } from "@/workflows/reminder-policy";
import { isRestoredHold } from "@/repositories/instance";
import { getConfig } from "@/config";

/**
 * 自研有限步骤 Agent 的“对象绑定与提问”层（REPAIR-PLAN §4.1.1/§5.1.1，AGENT-INTERFACE-CONTRACT §5）。
 * 输入是结构化意图（确定性解析或模型给出），这里重新读取当前事实，把文字引用绑定到具体对象：
 * 唯一就执行，并列只问选哪一个，没有就如实说找不到。输出只能是注册操作的参数、一个具体问题或失败原因。
 */

export type BindEnv = {
  intakeId: string | null;
  itemId: string | null;
  conversationId: string | null;
  referenceDate: string;
  now: Date;
  tz: string;
  /** 从哪张卡片/哪个对象发起（点开行动卡再说话） */
  selected: EntityRef | null;
  /** 已有回答（按问题键取结构化结果） */
  answer: (key: string) => Record<string, unknown> | null;
  /** 只读工具在这次处理里返回过的对象；按 ID 引用只认见过的 */
  seen?: EntityRef[];
  /** 同一句话里第 N 步产生的对象；null = 那一步还没完成 */
  stepRefs?: (step: number) => EntityRef[] | null;
  /** 这次路由里只读工具的查询记录：基于事实的回答只能引用这些 */
  observations?: Array<{ id: string; label: string }>;
};

export type QuestionSpec = { key: string; purpose: string; fieldPath: string; prompt: string; reason: string; options: string[]; context: Record<string, unknown> };

export type Bound =
  | { kind: "run"; command: Record<string, unknown>; replanDates?: string[] }
  /** 只读回答：解释状态，不改任何数据 */
  | { kind: "answer"; text: string; links?: ReadLink[] }
  | { kind: "ask"; question: QuestionSpec }
  | { kind: "fail"; error: string };

const POLICY_OPS = new Set(["no_study", "weekday_limit", "group_limit", "daily_limit", "date_limit", "window_end", "window_start", "holiday_policy", "prefer_window", "replan", "revoke_replan", "confirm_policy"]);
export const isPolicyIntent = (i: Intent): boolean => POLICY_OPS.has(i.op);

const PART_RANGE: Record<string, [string, string]> = { morning: ["00:00", "12:00"], afternoon: ["12:00", "18:00"], evening: ["18:00", "24:00"] };
const WEEKDAY = "一二三四五六日";

type SessionCand = { id: string; taskId: string; title: string; start: number; end: number; status: string };

function wall(date: string, time: string, tz: string): number {
  return time >= "24:00" ? wallTimeToUtc(addDays(date, 1), "00:00", tz).getTime() : wallTimeToUtc(date, time, tz).getTime();
}

function sessionLabel(s: SessionCand, env: BindEnv): string {
  const date = localDateInTz(new Date(s.start), env.tz);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: env.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s.start));
  const day = date === env.referenceDate ? "今天" : date === addDays(env.referenceDate, 1) ? "明天" : `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} 周${WEEKDAY[isoWeekday(date) - 1]}`;
  return `${day} ${time} 的「${s.title}」`;
}

function activeSessions(env: BindEnv): SessionCand[] {
  const rows = getDb()
    .prepare(
      `SELECT s.id, s.task_id, s.start_utc, s.end_utc, s.status, t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id
       WHERE s.status IN ('planned','tentative','in_progress') AND s.end_utc > ? ORDER BY s.start_utc, s.id`,
    )
    .all(env.now.toISOString()) as Array<{ id: string; task_id: string; start_utc: string; end_utc: string; status: string; title: string }>;
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, title: r.title, start: Date.parse(r.start_utc), end: Date.parse(r.end_utc), status: r.status }));
}

function openTasks(): TaskRef[] {
  return getDb().prepare(`SELECT id, title FROM tasks WHERE status IN ('todo','doing','blocked') AND archived_at IS NULL ORDER BY created_at, id`).all() as TaskRef[];
}

/** 还在定期关注的探索方向 */
export function topicRefs(): TaskRef[] {
  return getDb().prepare(`SELECT id, title FROM exploration_topics WHERE archived_at IS NULL ORDER BY created_at`).all() as TaskRef[];
}

/** 非课程的固定活动（课程投影出来的不算）：标题里附带了星期和钟点，便于并列时区分 */
export function fixedEventRefs(): Array<TaskRef & { name: string }> {
  const WD = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
  return (
    getDb()
      .prepare(`SELECT f.id, f.title, f.weekday, f.local_start, f.local_end, f.event_date FROM fixed_events f WHERE NOT EXISTS (SELECT 1 FROM course_meeting_projections p WHERE p.fixed_event_id = f.id) ORDER BY f.weekday, f.local_start`)
      .all() as Array<{ id: string; title: string; weekday: number; local_start: string; local_end: string; event_date: string | null }>
  ).map((r) => ({ id: r.id, name: r.title, title: `${r.title}（${r.event_date ?? `每${WD[r.weekday]}`} ${r.local_start}–${r.local_end}）` }));
}

function matchFixedEvents(name: string): ReturnType<typeof matchTask> {
  const hits = fixedEventRefs().filter((e) => e.name === name);
  if (hits.length === 1) return { kind: "one", task: hits[0]! };
  if (hits.length > 1) return { kind: "ambiguous", candidates: hits };
  return { kind: "none" };
}

function goalRefs(): TaskRef[] {
  return getDb().prepare(`SELECT id, title FROM goals WHERE archived_at IS NULL AND status != 'completed' ORDER BY created_at`).all() as TaskRef[];
}

function projectRefs(): TaskRef[] {
  return getDb().prepare(`SELECT id, title FROM projects WHERE archived_at IS NULL AND status != 'completed' ORDER BY created_at`).all() as TaskRef[];
}

/** 通知：标题取正文第一行（上游桥接的取上游标题） */
function noticeRefs(): TaskRef[] {
  const rows = getDb()
    .prepare(`SELECT m.id, r.text FROM inbox_messages m JOIN inbox_revisions r ON r.id = m.current_revision_id ORDER BY m.updated_at DESC, m.id DESC LIMIT 300`)
    .all() as Array<{ id: string; text: string }>;
  return rows.map((r) => ({ id: r.id, title: (/^上游标题：(.*)$/m.exec(r.text)?.[1] ?? r.text.split("\n").find((l) => l.trim()) ?? "").trim().slice(0, 80) || "通知" }));
}

function courseSetRefs(): TaskRef[] {
  return (getDb().prepare(`SELECT id, created_at FROM course_sets WHERE status = 'active' ORDER BY created_at`).all() as Array<{ id: string; created_at: string }>).map((r) => ({ id: r.id, title: `${r.created_at.slice(0, 10)} 导入的课表` }));
}

/** 方向页展示的候选（与页面同序）：还没开始、没被否掉的 */
export function candidateRefs(): TaskRef[] {
  return getDb().prepare(`SELECT id, title FROM candidates WHERE status IN ('proposed','idea') AND project_id IS NULL ORDER BY updated_at DESC, id LIMIT 3`).all() as TaskRef[];
}

function primaryGoalId(): string | null {
  return (getDb().prepare(`SELECT id FROM goals WHERE archived_at IS NULL AND status = 'active' AND priority = 1 LIMIT 1`).get() as { id: string } | undefined)?.id ?? null;
}

function recentResourceId(env: BindEnv): string | null {
  for (const r of recentRefs(env)) if (r.kind === "resource") return r.id;
  const since = new Date(env.now.getTime() - 86_400_000).toISOString();
  return (getDb().prepare(`SELECT id FROM resources WHERE archived_at IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(since) as { id: string } | undefined)?.id ?? null;
}

function asResolved(m: ReturnType<typeof matchTask>, whyNone: string): Resolved<TaskRef> {
  if (m.kind === "one") return { kind: "one", value: m.task };
  if (m.kind === "ambiguous") return { kind: "many", values: m.candidates };
  return { kind: "none", why: whyNone };
}

/** 对话里最近提到的对象（新→旧），外加从卡片带来的选中对象 */
function recentRefs(env: BindEnv): EntityRef[] {
  const out: EntityRef[] = env.selected ? [env.selected] : [];
  if (env.conversationId) for (const turn of agentTurnsBefore(env.conversationId, env.intakeId)) out.push(...turn.refs);
  return out;
}

type Resolved<T> = { kind: "one"; value: T } | { kind: "many"; values: T[] } | { kind: "none"; why: string };

/** 按 ID / 步骤引用时可用的对象：ID 必须出现在选中、对话或只读工具结果里，步骤必须已经完成 */
function refTargets(ref: Extract<Ref, { kind: "id" | "step" }>, env: BindEnv): { ok: true; refs: EntityRef[] } | { ok: false; why: string } {
  if (ref.kind === "id") {
    const seen = [...recentRefs(env), ...(env.seen ?? [])];
    return seen.some((r) => r.kind === ref.entityKind && r.id === ref.id) ? { ok: true, refs: [{ kind: ref.entityKind, id: ref.id }] } : { ok: false, why: "引用的对象没有在这次对话或查询结果里出现过，不按猜测的 ID 执行" };
  }
  const refs = env.stepRefs?.(ref.step);
  if (refs === undefined) return { ok: false, why: `引用了第 ${ref.step} 步的结果，但这里不是多步执行` };
  if (refs === null) return { ok: false, why: `第 ${ref.step} 步还没有完成，不能引用它的结果` };
  return { ok: true, refs };
}

const sessionTask = (id: string) => (getDb().prepare(`SELECT task_id FROM plan_sessions WHERE id = ?`).get(id) as { task_id: string } | undefined)?.task_id;

/** 项目、目标、通知等列表型对象的统一解析 */
function resolvePooled(ref: Ref, env: BindEnv, kind: string, pool: TaskRef[], whyNone: string): Resolved<TaskRef> {
  if (ref.kind === "named") return asResolved(matchTask(ref.text, pool), whyNone);
  if (ref.kind === "recent") {
    for (const r of recentRefs(env)) {
      const hit = r.kind === kind ? pool.find((p) => p.id === r.id) : undefined;
      if (hit) return { kind: "one", value: hit };
    }
    return { kind: "none", why: whyNone };
  }
  const t = refTargets(ref, env);
  if (!t.ok) return { kind: "none", why: t.why };
  const hit = t.refs.map((r) => (r.kind === kind ? pool.find((p) => p.id === r.id) : undefined)).find(Boolean);
  return hit ? { kind: "one", value: hit } : { kind: "none", why: whyNone };
}

function resolveSession(ref: Ref, env: BindEnv): Resolved<SessionCand> {
  const active = activeSessions(env);
  if (ref.kind === "id" || ref.kind === "step") {
    const t = refTargets(ref, env);
    if (!t.ok) return { kind: "none", why: t.why };
    for (const r of t.refs) {
      const hit = r.kind === "plan_session" ? active.find((s) => s.id === r.id) : r.kind === "task" ? active.find((s) => s.taskId === r.id) : undefined;
      if (hit) return { kind: "one", value: hit };
    }
    return { kind: "none", why: "引用的学习安排已经结束、取消或不存在" };
  }
  if (ref.kind === "recent") {
    for (const r of recentRefs(env)) {
      const hit = r.kind === "plan_session" ? active.find((s) => s.id === r.id) : r.kind === "task" ? active.find((s) => s.taskId === r.id) : undefined;
      if (hit) return { kind: "one", value: hit };
    }
    return { kind: "none", why: "不确定你说的“刚才那个”是哪一项安排，说一下名称我就能改" };
  }
  const pick = (pool: SessionCand[]): Resolved<SessionCand> | null => {
    const tasks = [...new Map(pool.map((s) => [s.taskId, { id: s.taskId, title: s.title }])).values()];
    const m = matchTask(ref.text, tasks);
    if (m.kind === "one") return { kind: "one", value: pool.find((s) => s.taskId === m.task.id)! };
    if (m.kind === "ambiguous") return { kind: "many", values: m.candidates.map((c) => pool.find((s) => s.taskId === c.id)!) };
    // 名称很泛（“复习”“那个安排”）但范围内只有一个安排：就是它
    if (pool.length === 1 && (ref.date !== null || ref.part !== "any")) return { kind: "one", value: pool[0]! };
    return null;
  };
  let pool = active;
  if (ref.date) pool = pool.filter((s) => localDateInTz(new Date(s.start), env.tz) === ref.date);
  if (ref.part !== "any") {
    pool = pool.filter((s) => {
      const d = localDateInTz(new Date(s.start), env.tz);
      const [from, to] = PART_RANGE[ref.part]!;
      return s.start >= wall(d, from, env.tz) && s.start < wall(d, to, env.tz);
    });
  }
  // 限定的日期/时段里没有，就在全部安排里找（“今晚微积分”其实排在明天也能认出来）
  return pick(pool) ?? pick(active) ?? { kind: "none", why: `没有找到和「${ref.text}」对应的学习安排` };
}

function resolveTask(ref: Ref, env: BindEnv): Resolved<TaskRef> {
  const tasks = openTasks();
  const fromRefs = (refs: EntityRef[]) => {
    for (const r of refs) {
      const id = r.kind === "task" ? r.id : r.kind === "plan_session" ? sessionTask(r.id) : undefined;
      const hit = tasks.find((t) => t.id === id);
      if (hit) return hit;
    }
    return null;
  };
  if (ref.kind === "id" || ref.kind === "step") {
    const t = refTargets(ref, env);
    if (!t.ok) return { kind: "none", why: t.why };
    const hit = fromRefs(t.refs);
    return hit ? { kind: "one", value: hit } : { kind: "none", why: "引用的任务已经完成、归档或不存在" };
  }
  if (ref.kind === "recent") {
    const hit = fromRefs(recentRefs(env));
    return hit ? { kind: "one", value: hit } : { kind: "none", why: "不确定你说的是哪个任务，说一下名称" };
  }
  const m = matchTask(ref.text, tasks);
  if (m.kind === "one") return { kind: "one", value: m.task };
  if (m.kind === "ambiguous") return { kind: "many", values: m.candidates };
  return { kind: "none", why: `没有找到叫「${ref.text}」的任务` };
}

/**
 * 并列时只问选哪一个；已经回答过就用回答。
 * 回答引用的对象在等待期间变了（已完成、已改期、已不在候选里）：不执行过时的选择，如实说明。
 */
function chooseOrAsk<T extends { id: string }>(r: Resolved<T>, env: BindEnv, kind: string, label: (v: T) => string, what: string): { kind: "one"; value: T } | Bound {
  const key = `entity_ref:${env.itemId ?? env.intakeId ?? "direct"}`;
  const answeredId = (env.answer(key)?.ref as EntityRef | undefined)?.id;
  if (answeredId) {
    const pool = r.kind === "many" ? r.values : r.kind === "one" ? [r.value] : [];
    const picked = pool.find((v) => v.id === answeredId);
    return picked ? { kind: "one", value: picked } : { kind: "fail", error: `你选的那项${what}在这期间已经变了（完成、改期或取消），这次没有照旧执行；还需要的话再说一次` };
  }
  if (r.kind === "one") return r;
  if (r.kind === "none") return { kind: "fail", error: r.why };
  const candidates = r.values.map((v) => ({ kind, id: v.id, label: label(v) }));
  return {
    kind: "ask",
    question: {
      key,
      purpose: "entity_ref",
      fieldPath: `${kind}.ref`,
      prompt: `你说的${what}是哪一个？${candidates.map((c, i) => `${i + 1}. ${c.label}`).join("；")}`,
      reason: "有多个对象都对得上，我不猜",
      options: candidates.map((c) => c.label),
      context: { candidates },
    },
  };
}

type PolicyPatch = { base: Record<string, unknown>; rules: Array<Record<string, unknown>>; revokeRuleIds: string[]; confirm: boolean; replanDates: string[] };

function mergePolicy(intents: Intent[], env: BindEnv): Bound {
  const patch: PolicyPatch = { base: {}, rules: [], revokeRuleIds: [], confirm: false, replanDates: [] };
  for (const i of intents) {
    if (i.op === "no_study") patch.rules.push({ kind: "no_study", dateFrom: i.dateFrom, dateTo: i.dateTo, scope: "temporary", value: { ...(i.fromTime ? { fromTime: i.fromTime } : {}), label: i.label } });
    else if (i.op === "group_limit") {
      patch.rules.push({ kind: "group_limit", scope: "persistent", value: { group: i.group, limitMinutes: i.limitMinutes } });
      patch.confirm = true;
    } else if (i.op === "date_limit") patch.rules.push({ kind: "date_limit", dateFrom: i.date, dateTo: i.date, scope: "temporary", value: { limitMinutes: i.limitMinutes } });
    else if (i.op === "daily_limit") {
      patch.base.dailyLimitMinutes = i.limitMinutes;
      patch.confirm = true;
    } else if (i.op === "window_end") {
      if (i.days !== "weekend") patch.base.workdayEnd = i.time;
      if (i.days !== "workday") patch.base.weekendEnd = i.time;
      patch.confirm = true;
    } else if (i.op === "window_start") {
      if (i.days !== "weekend") patch.base.workdayStart = i.time;
      if (i.days !== "workday") patch.base.weekendStart = i.time;
      patch.confirm = true;
    } else if (i.op === "holiday_policy") patch.rules.push({ kind: "holiday_policy", scope: "persistent", value: { mode: i.mode, ...(i.mode === "reduced" ? { limitMinutes: 60 } : {}) } });
    else if (i.op === "prefer_window") patch.rules.push({ kind: "preferred_window", scope: "persistent", value: { part: i.part } });
    else if (i.op === "confirm_policy") patch.confirm = true;
    else if (i.op === "replan") {
      // 授权只覆盖说到的那几天里未锁定、未开始的学习安排；课程、截止、锁定块都不在范围内
      // 先限跨度再展开日期：坏日期或超过 31 天的范围不逐日展开
      if (i.dateTo < i.dateFrom || Date.parse(i.dateTo) - Date.parse(i.dateFrom) > 30 * 86_400_000 || Number.isNaN(Date.parse(i.dateFrom))) return { kind: "fail", error: `重新安排的范围 ${i.dateFrom}–${i.dateTo} 无效或超过 31 天，没有执行` };
      patch.rules.push({ kind: "auto_reschedule", dateFrom: i.dateFrom, dateTo: i.dateTo, scope: "temporary", value: {} });
      for (let d = i.dateFrom; d <= i.dateTo; d = addDays(d, 1)) patch.replanDates.push(d);
    } else if (i.op === "revoke_replan") {
      patch.revokeRuleIds.push(...activePolicyRules().filter((r) => r.kind === "auto_reschedule").map((r) => r.id));
      if (!patch.revokeRuleIds.length && intents.length === 1) return { kind: "fail", error: "现在没有生效的“可以重新安排”授权，近期安排本来就不会被自动改动" };
    } else if (i.op === "weekday_limit") {
      if (i.persistent) {
        patch.rules.push({ kind: "weekday_limit", weekday: i.weekday, scope: "persistent", value: { limitMinutes: i.limitMinutes } });
        continue;
      }
      // 没说“以后”：一次表达不记成长期上限，先问清范围
      const key = `scope:${env.itemId ?? env.intakeId ?? "direct"}`;
      const choice = env.answer(key)?.choice;
      const next = addDays(env.referenceDate, (i.weekday - isoWeekday(env.referenceDate) + 7) % 7);
      if (choice === "always") patch.rules.push({ kind: "weekday_limit", weekday: i.weekday, scope: "persistent", value: { limitMinutes: i.limitMinutes } });
      else if (choice === "once") patch.rules.push({ kind: "date_limit", dateFrom: next, dateTo: next, scope: "temporary", value: { limitMinutes: i.limitMinutes } });
      else {
        return {
          kind: "ask",
          question: {
            key,
            purpose: "scope",
            fieldPath: "policy.scope",
            prompt: `周${WEEKDAY[i.weekday - 1]}最多 ${i.limitMinutes} 分钟——只是这个周${WEEKDAY[i.weekday - 1]}（${next}），还是以后每个周${WEEKDAY[i.weekday - 1]}都这样？`,
            reason: "一次的调整和长期规则影响的范围不同",
            options: [`只这个周${WEEKDAY[i.weekday - 1]}`, `以后每个周${WEEKDAY[i.weekday - 1]}`],
            context: { choices: ["once", "always"] },
          },
        };
      }
    }
  }
  const command: Record<string, unknown> = { command: "update_planning_policy", rules: patch.rules, revokeRuleIds: patch.revokeRuleIds, confirm: patch.confirm };
  if (Object.keys(patch.base).length) command.base = patch.base;
  return { kind: "run", command, replanDates: patch.replanDates };
}

function latestUndoableBatch(env: BindEnv): string | null {
  if (!env.conversationId) return null;
  for (const turn of agentTurnsBefore(env.conversationId, env.intakeId, 10)) {
    for (const id of [...turn.batchIds].reverse()) {
      const b = getBatch(id);
      // 重排批次跟着引起它的那次调整一起撤，不单独作为“刚才的调整”
      if (b && b.status === "applied" && b.command !== "plan_sessions" && b.command !== "undo_batch") return id;
    }
  }
  return null;
}

function bindOne(intent: Intent, env: BindEnv): Bound {
  const hm = (ms: number) => new Intl.DateTimeFormat("en-GB", { timeZone: env.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  if (intent.op === "undo") {
    const batchId = latestUndoableBatch(env);
    return batchId ? { kind: "run", command: { command: "undo_batch", batchId } } : { kind: "fail", error: "这次对话里没有可以撤销的调整" };
  }
  if (intent.op === "move_session" || intent.op === "shorten_session") {
    const s = chooseOrAsk(resolveSession(intent.ref, env), env, "plan_session", (v) => sessionLabel(v, env), "安排");
    if (s.kind !== "one") return s;
    if (intent.op === "shorten_session") {
      // 只改这一段的长度，位置不动
      return { kind: "run", command: { command: "reschedule_session", sessionId: s.value.id, targetDate: localDateInTz(new Date(s.value.start), env.tz), startLocalTime: hm(Math.max(s.value.start, env.now.getTime())), durationMinutes: intent.durationMinutes } };
    }
    return { kind: "run", command: { command: "reschedule_session", sessionId: s.value.id, targetDate: intent.targetDate, part: intent.part, startLocalTime: intent.startLocalTime } };
  }
  if (intent.op === "correct_practice") {
    const refs = recentRefs(env).filter((r) => r.kind === "practice_entry");
    const row =
      (refs.length ? (getDb().prepare(`SELECT id FROM practice_entries WHERE id = ?`).get(refs[0]!.id) as { id: string } | undefined) : undefined) ??
      (getDb().prepare(`SELECT id FROM practice_entries WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1`).get(new Date(env.now.getTime() - 7 * 86_400_000).toISOString()) as { id: string } | undefined);
    return row ? { kind: "run", command: { command: "correct_practice", practiceId: row.id, actualMinutes: intent.minutes } } : { kind: "fail", error: "最近没有可以纠正的实践记录" };
  }
  if (intent.op === "goal") {
    const existing = matchTask(intent.title, goalRefs());
    return { kind: "run", command: { command: "upsert_goal", ...(existing.kind === "one" ? { goalId: existing.task.id } : { title: intent.title, horizon: intent.horizon }), primary: intent.primary } };
  }
  if (intent.op === "explore") return { kind: "run", command: { command: "request_exploration", query: intent.query } };
  if (intent.op === "trial") {
    const list = candidateRefs();
    let picked: TaskRef | undefined;
    if (intent.ordinal) picked = list[intent.ordinal - 1];
    else if (intent.ref.kind === "recent") picked = recentRefs(env).map((r) => (r.kind === "candidate" ? list.find((c) => c.id === r.id) : undefined)).find(Boolean) ?? (list.length === 1 ? list[0] : undefined);
    else {
      const why = intent.ref.kind === "named" ? `还没有和「${intent.ref.text}」对应的候选项目。可以说“帮我找一个……的小项目”，候选出来后再选` : "引用的候选项目已经不在候选里";
      const c = chooseOrAsk(resolvePooled(intent.ref, env, "candidate", list, why), env, "candidate", (v) => v.title, "候选项目");
      if (c.kind !== "one") return c;
      picked = c.value;
    }
    if (!picked) return { kind: "fail", error: list.length ? `有 ${list.length} 个候选，说一下是哪一个（名称或“第几个”）` : "现在没有候选项目。可以说“帮我找一个……的小项目”" };
    return { kind: "run", command: { command: "select_candidate", candidateId: picked.id, mode: "trial", trialWeeks: intent.weeks, goalId: primaryGoalId() } };
  }
  if (intent.op === "project_state") {
    const p = chooseOrAsk(resolvePooled(intent.ref, env, "project", projectRefs(), "没有找到这个项目"), env, "project", (v) => v.title, "项目");
    if (p.kind !== "one") return p;
    return { kind: "run", command: { command: "update_project_state", projectId: p.value.id, ...(intent.status ? { status: intent.status } : {}), ...(intent.commit ? { engagement: "committed" } : {}) } };
  }
  if (intent.op === "resource_link" || intent.op === "resource_role") {
    const resourceId = recentResourceId(env);
    if (!resourceId) return { kind: "fail", error: "不确定你说的是哪份资料——先把资料放进来，再告诉我它归到哪里" };
    if (intent.op === "resource_role") return { kind: "run", command: { command: "link_resource", resourceId, role: intent.role, origin: "user" } };
    const p = chooseOrAsk(asResolved(matchTask(intent.projectText, projectRefs()), `没有找到叫「${intent.projectText}」的项目`), env, "project", (v) => v.title, "项目");
    if (p.kind !== "one") return p;
    return { kind: "run", command: { command: "link_resource", resourceId, projectId: p.value.id, origin: "user" } };
  }
  if (intent.op === "profile") return { kind: "run", command: { command: "update_profile_fact", facts: intent.facts } };
  if (intent.op === "notice_filter") {
    if (intent.value === "*") {
      const filters = noticeFilters();
      if (!filters.length) return { kind: "fail", error: "现在没有生效的通知筛选规则" };
      const last = filters[filters.length - 1]!;
      return { kind: "run", command: { command: "upsert_notice_rule", field: last.field, value: last.value, remove: true } };
    }
    return { kind: "run", command: { command: "upsert_notice_rule", field: intent.field, value: intent.value, remove: intent.remove } };
  }
  if (intent.op === "export") return { kind: "run", command: { command: "request_export" } };
  if (intent.op === "inspect") {
    if (/提醒|邮件/.test(intent.query)) return { kind: "answer", text: explainReminders(env), links: [{ href: "/settings", label: "打开提醒设置" }] };
    if (/为什么.*(?:安排|排)|(?:这样|这么)(?:安排|排)/.test(intent.query)) return { kind: "answer", text: explainPlan(env), links: [{ href: "/week", label: "打开本周时间轴" }] };
    return { kind: "answer", ...answerReadRequest(intent.query, env) };
  }
  if (intent.op === "explain") return { kind: "answer", text: intent.topic === "reminders" ? explainReminders(env) : explainPlan(env) };
  if (intent.op === "answer") {
    const used = intent.sources.map((s) => env.observations?.find((o) => o.id === s));
    if (!used.length || used.some((o) => !o)) return { kind: "fail", error: "这个回答没有对应的查询依据，没有采用；可以换个问法再问" };
    return { kind: "answer", text: `${intent.text}\n\n依据（只读查询）：${[...new Set(used.map((o) => o!.label))].join("；")}` };
  }
  if (intent.op === "schedule_here") {
    // 从时间轴空档发起：对得上已有任务就给它排，对不上就按这句话新建一个
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const endMin = intent.end >= "24:00" ? 1440 : toMin(intent.end);
    // 今天的空档可能已经过去一截：从现在之后的整 5 分钟开始
    let startMin = toMin(intent.start);
    if (localDateInTz(env.now, env.tz) === intent.date) {
      const nowMin = Math.ceil(((env.now.getTime() - wallTimeToUtc(intent.date, "00:00", env.tz).getTime()) / 60000) / 5) * 5;
      startMin = Math.max(startMin, nowMin);
    }
    const slotMinutes = endMin - startMin;
    if (slotMinutes < 5) return { kind: "fail", error: "这个空档已经过去了，换一个时段再安排" };
    const startLocalTime = `${String(Math.floor(startMin / 60)).padStart(2, "0")}:${String(startMin % 60).padStart(2, "0")}`;
    const said = estimateFromText(intent.text);
    const m = matchTask(intent.text, openTasks());
    let taskId: string | null = m.kind === "one" ? m.task.id : null;
    if (m.kind === "ambiguous") {
      const c = chooseOrAsk({ kind: "many", values: m.candidates }, env, "task", (v) => v.title, "任务");
      if (c.kind !== "one") return c;
      taskId = c.value.id;
    }
    // 时长：话里说了按话里的；否则已有任务按它的估时，最多 90 分钟一段，都不超过空档
    const known = taskId ? ((getDb().prepare(`SELECT estimate_minutes FROM tasks WHERE id = ?`).get(taskId) as { estimate_minutes: number | null } | undefined)?.estimate_minutes ?? null) : null;
    const durationMinutes = Math.max(5, Math.min(slotMinutes, said ?? Math.min(90, known ?? 60)));
    return { kind: "run", command: { command: "schedule_session", ...(taskId ? { taskId } : { title: intent.text }), date: intent.date, startLocalTime, durationMinutes } };
  }
  if (intent.op === "agent_policy") {
    return {
      kind: "run",
      command: {
        command: "update_agent_policy",
        ...(intent.dailyModelCalls !== undefined ? { dailyModelCalls: intent.dailyModelCalls } : {}),
        ...(intent.scheduledEnabled !== undefined ? { scheduledEnabled: intent.scheduledEnabled } : {}),
        ...(intent.weeklyReview !== undefined ? { weeklyReview: intent.weeklyReview } : {}),
      },
    };
  }
  if (intent.op === "review") return { kind: "run", command: { command: "request_review", week: intent.week } };
  if (intent.op === "digest_now") return { kind: "run", command: { command: "request_owner_digest", kind: intent.kind } };
  if (intent.op === "cancel_intake") {
    // 同一段对话里最近一份还没处理完的投递（不是当前这句话本身）
    const row = getDb()
      .prepare(`SELECT id FROM intakes WHERE id != ? AND status IN ('received','processing','waiting_input','partially_applied') ORDER BY (conversation_id IS ?) DESC, created_at DESC LIMIT 1`)
      .get(env.intakeId ?? "", env.conversationId) as { id: string } | undefined;
    if (!row) return { kind: "fail", error: "现在没有还在处理中的材料；已经生效的变化要撤回，直接说“撤销”" };
    return { kind: "run", command: { command: "cancel_operation", intakeId: row.id } };
  }
  if (intent.op === "explore_topic") {
    const topics = topicRefs();
    const m = matchTask(intent.title, topics);
    if (intent.stop) {
      const c = chooseOrAsk(asResolved(m, `没有在定期关注「${intent.title}」`), env, "exploration_topic", (v) => v.title, "关注方向");
      if (c.kind !== "one") return c;
      return { kind: "run", command: { command: "configure_exploration", topicId: c.value.id, archive: true } };
    }
    const same = m.kind === "one" ? m.task : null;
    return {
      kind: "run",
      command: { command: "configure_exploration", ...(same ? { topicId: same.id } : { title: intent.title }), enabled: true, ...(intent.weekday ? { weekday: intent.weekday } : {}), ...(intent.localTime ? { localTime: intent.localTime } : {}) },
    };
  }
  if (intent.op === "fixed_event") {
    const c = chooseOrAsk(asResolved(matchFixedEvents(intent.name), `没有找到叫「${intent.name}」的固定活动`), env, "fixed_event", (v) => v.title, "固定活动");
    if (c.kind !== "one") return c;
    const args = intent.skipDate
      ? { skipDate: intent.skipDate }
      : intent.remove
        ? { remove: true }
        : { ...(intent.weekday ? { weekday: intent.weekday } : {}), ...(intent.start ? { localStart: intent.start } : {}), ...(intent.end ? { localEnd: intent.end } : {}) };
    const dates = intent.skipDate ? [intent.skipDate] : [];
    return { kind: "run", command: { command: "update_fixed_event", eventId: c.value.id, ...args }, replanDates: dates };
  }
  if (intent.op === "digest") {
    const command: Record<string, unknown> = { command: "update_digest_policy" };
    if (intent.dailyEnabled !== undefined) command.dailyEnabled = intent.dailyEnabled;
    if (intent.dailyTime) command.dailyTime = intent.dailyTime;
    if (intent.weekdaysOnly !== undefined) command.dailyWeekdaysOnly = intent.weekdaysOnly;
    if (intent.weeklyEnabled !== undefined) command.weeklyEnabled = intent.weeklyEnabled;
    if (intent.weeklyWeekday) command.weeklyWeekday = intent.weeklyWeekday;
    if (intent.weeklyTime) command.weeklyTime = intent.weeklyTime;
    return { kind: "run", command };
  }
  if (intent.op === "reminders") {
    return { kind: "run", command: { command: "update_reminder_policy", ...(intent.enabled !== undefined ? { deadlineReminders: intent.enabled } : {}), ...(intent.quietStart ? { quietEnabled: true, quietStart: intent.quietStart, quietEnd: intent.quietEnd } : {}) } };
  }
  if (intent.op === "task_reminder") {
    const t = chooseOrAsk(resolveTask(intent.ref, env), env, "task", (v) => v.title, "任务");
    if (t.kind !== "one") return t;
    return { kind: "run", command: { command: "update_reminder_policy", taskId: t.value.id, taskLeadMinutes: intent.leadMinutes } };
  }
  if (intent.op === "calendar_sync") {
    return { kind: "run", command: { command: "update_calendar_sync_policy", enabled: intent.enabled, ...(intent.intervalDays ? { intervalDays: intent.intervalDays } : {}) } };
  }
  if (intent.op === "course_cancel") {
    return intent.courseName
      ? { kind: "run", command: { command: "apply_teaching_day_override", scope: "course", courseName: intent.courseName, mode: "cancel", sourceTeachingDate: intent.date, origin: "user" } }
      : { kind: "run", command: { command: "apply_teaching_day_override", scope: "school", mode: "cancel", sourceTeachingDate: intent.date, origin: "user" } };
  }
  if (intent.op === "course_move") {
    if (!intent.courseName) {
      return { kind: "run", command: { command: "apply_teaching_day_override", scope: "school", mode: "replace", sourceTeachingDate: intent.sourceDate, targetDate: intent.targetDate, cancelSource: true, origin: "user" } };
    }
    let targetEnd: string | null = null;
    if (intent.startLocalTime) {
      // 改了钟点：时长沿用原来那次课
      const inst = calendarDay(intent.sourceDate, env.tz).courses.find((c) => c.courseName.includes(intent.courseName!) || intent.courseName!.includes(c.courseName));
      const minutes = inst ? Math.round((inst.interval[1] - inst.interval[0]) / 60000) : 90;
      const [h, m] = intent.startLocalTime.split(":").map(Number) as [number, number];
      const end = h * 60 + m + minutes;
      if (end >= 24 * 60) return { kind: "fail", error: "这个钟点上完会跨过午夜，请换个时间" };
      targetEnd = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
    }
    return { kind: "run", command: { command: "apply_teaching_day_override", scope: "course", courseName: intent.courseName, mode: "move", sourceTeachingDate: intent.sourceDate, targetDate: intent.targetDate, targetStart: intent.startLocalTime, targetEnd, origin: "user" } };
  }
  if (intent.op === "create_task") {
    let projectId: string | null = null;
    if (intent.projectRef) {
      const why = intent.projectRef.kind === "named" ? `没有找到叫「${intent.projectRef.text}」的项目，任务没有创建` : "引用的项目不存在或已结束，任务没有创建";
      const p = chooseOrAsk(resolvePooled(intent.projectRef, env, "project", projectRefs(), why), env, "project", (v) => v.title, "项目");
      if (p.kind !== "one") return p;
      projectId = p.value.id;
    }
    return {
      kind: "run",
      command: { command: "create_or_update_task", title: intent.title, ...(intent.taskKind ? { taskKind: intent.taskKind } : {}), estimateMinutes: intent.estimateMinutes, dueLocalDate: intent.dueLocalDate, dueLocalTime: intent.dueLocalTime, priority: intent.priority, ...(projectId ? { projectId } : {}) },
    };
  }
  if (intent.op === "practice") {
    if (intent.occurredOn > env.referenceDate) return { kind: "fail", error: "实践记录只能记已经发生的投入，日期不能在今天之后" };
    let taskId: string | null = null;
    let projectId: string | null = null;
    if (intent.taskRef) {
      const t = chooseOrAsk(resolveTask(intent.taskRef, env), env, "task", (v) => v.title, "任务");
      if (t.kind !== "one") return t;
      taskId = t.value.id;
    }
    if (intent.projectRef) {
      const p = chooseOrAsk(resolvePooled(intent.projectRef, env, "project", projectRefs(), "没有找到这个项目，记录没有保存"), env, "project", (v) => v.title, "项目");
      if (p.kind !== "one") return p;
      projectId = p.value.id;
    }
    return { kind: "run", command: { command: "record_practice", occurredOn: intent.occurredOn, actualMinutes: intent.actualMinutes, note: intent.note, category: intent.category, taskId, projectId, blocker: intent.blocker } };
  }
  if (intent.op === "schedule_at") {
    if (intent.taskRef) {
      const t = chooseOrAsk(resolveTask(intent.taskRef, env), env, "task", (v) => v.title, "任务");
      if (t.kind !== "one") return t;
      return { kind: "run", command: { command: "schedule_session", taskId: t.value.id, date: intent.date, startLocalTime: intent.startLocalTime, durationMinutes: intent.durationMinutes } };
    }
    if (!intent.title) return { kind: "fail", error: "要安排哪件事？说一下任务名称" };
    return { kind: "run", command: { command: "schedule_session", title: intent.title, date: intent.date, startLocalTime: intent.startLocalTime, durationMinutes: intent.durationMinutes } };
  }
  if (intent.op === "session_state") {
    const s = chooseOrAsk(resolveSession(intent.ref, env), env, "plan_session", (v) => sessionLabel(v, env), "安排");
    if (s.kind !== "one") return s;
    return { kind: "run", command: { command: "set_session_state", sessionId: s.value.id, action: intent.action, actualMinutes: intent.actualMinutes } };
  }
  if (intent.op === "resolve_notice") {
    const n = chooseOrAsk(resolvePooled(intent.ref, env, "inbox_message", noticeRefs(), "没有找到这条通知"), env, "inbox_message", (v) => v.title, "通知");
    if (n.kind !== "one") return n;
    return { kind: "run", command: { command: "resolve_notice", messageId: n.value.id, partition: intent.partition } };
  }
  if (intent.op === "archive") {
    if (intent.entityKind === "task") {
      const t = chooseOrAsk(resolveTask(intent.ref, env), env, "task", (v) => v.title, "任务");
      if (t.kind !== "one") return t;
      return { kind: "run", command: { command: "archive_entity", entityKind: "task", entityId: t.value.id } };
    }
    if (intent.entityKind === "goal") {
      const g = chooseOrAsk(resolvePooled(intent.ref, env, "goal", goalRefs(), "没有找到这个目标"), env, "goal", (v) => v.title, "目标");
      if (g.kind !== "one") return g;
      return { kind: "run", command: { command: "archive_entity", entityKind: "goal", entityId: g.value.id } };
    }
    if (intent.entityKind === "course_set") {
      const sets = courseSetRefs();
      const r = intent.ref.kind === "named" && sets.length === 1 ? { kind: "one" as const, value: sets[0]! } : resolvePooled(intent.ref, env, "course_set", sets, "现在没有可以归档的课表");
      const c = chooseOrAsk(r, env, "course_set", (v) => v.title, "课表");
      if (c.kind !== "one") return c;
      return { kind: "run", command: { command: "archive_entity", entityKind: "course_set", entityId: c.value.id } };
    }
    const HOW: Record<string, string> = { project: "项目请说“结束项目”或“暂停项目”", resource: "资料暂不支持归档，可以改它的归属或用途", fixed_event: "固定活动请说“删除这个固定活动”", practice_entry: "实践记录不能归档，可以纠正分钟或日期", plan_session: "学习安排请说“跳过”或“挪到别的时间”" };
    return { kind: "fail", error: `归档只支持任务、目标和课表；${HOW[intent.entityKind] ?? "这类对象不能归档"}` };
  }
  // 以下都针对任务
  if (intent.op === "classify_task" || intent.op === "pause_task" || intent.op === "resume_task" || intent.op === "prioritize" || intent.op === "set_due" || intent.op === "remaining" || intent.op === "complete") {
    const resolved = resolveTask(intent.ref, env);
    // “数学优先”但没有叫数学的任务：这是在说目标/方向的优先，而不是某个任务
    if (intent.op === "prioritize" && resolved.kind === "none" && intent.ref.kind === "named") {
      const goal = matchTask(intent.ref.text, goalRefs());
      return { kind: "run", command: { command: "upsert_goal", ...(goal.kind === "one" ? { goalId: goal.task.id } : { title: intent.ref.text, horizon: "semester" }), primary: true } };
    }
    const t = chooseOrAsk(resolved, env, "task", (v) => v.title, "任务");
    if (t.kind !== "one") return t;
    const taskId = t.value.id;
    if (intent.op === "classify_task") return { kind: "run", command: { command: "create_or_update_task", taskId, taskKind: intent.taskKind } };
    if (intent.op === "pause_task") return { kind: "run", command: { command: "pause_task", taskId, until: intent.until } };
    if (intent.op === "resume_task") return { kind: "run", command: { command: "pause_task", taskId, resume: true } };
    if (intent.op === "prioritize") return { kind: "run", command: { command: "create_or_update_task", taskId, priority: "high" } };
    if (intent.op === "set_due") return { kind: "run", command: { command: "create_or_update_task", taskId, dueLocalDate: intent.dueLocalDate, dueLocalTime: intent.dueLocalTime } };
    if (intent.op === "remaining") return { kind: "run", command: { command: "create_or_update_task", taskId, remainingMinutes: intent.minutes } };
    return { kind: "run", command: { command: "complete_task", taskId, occurredOn: env.referenceDate, actualMinutes: intent.actualMinutes } };
  }
  return { kind: "fail", error: "这条指令现在还处理不了" };
}

/** “为什么没提醒我”：只说查得到的事实——策略、邮箱配置、已排的提醒、最近的投递状态；结果不确定的不说成已送达 */
function explainReminders(env: BindEnv): string {
  const db = getDb();
  const policy = reminderPolicy();
  const lines: string[] = [];
  if (!policy.deadlineReminders) lines.push("截止提醒现在是关闭的，所以不会发提醒邮件。说“开启提醒”可以恢复。");
  const cfg = getConfig();
  if (!cfg.MAIL_TO) lines.push("还没有配置收件邮箱（MAIL_TO），所以邮件发不出去；提醒只会出现在页面上。");
  if (!cfg.SMTP_HOST) lines.push("发信服务器（SMTP）没有配置。");
  if (isRestoredHold()) lines.push("实例处于恢复后的暂停状态，邮件、模型和抓取都不会发起，需要先恢复运行。");
  const queued = db.prepare(`SELECT COUNT(*) AS n, MIN(run_at) AS next FROM jobs WHERE type = 'reminder' AND status = 'queued'`).get() as { n: number; next: string | null };
  lines.push(queued.n ? `已排好 ${queued.n} 个提醒，最近一个在 ${labelAt(queued.next!, env.tz)}。` : "现在没有排队中的提醒（没有带截止的未完成任务，或提醒时间已过）。");
  if (policy.quietEnabled) lines.push(`${policy.quietStart}–${policy.quietEnd} 是安静时段，落在这段的提醒会顺延到 ${policy.quietEnd}。`);
  const recent = db.prepare(`SELECT status, subject, updated_at FROM deliveries ORDER BY updated_at DESC LIMIT 5`).all() as Array<{ status: string; subject: string; updated_at: string }>;
  const STATUS: Record<string, string> = { accepted: "发信服务器已接受（不等于你一定收到了）", unknown: "结果不确定，不会自动重发", failed: "发送失败", cancelled: "已取消", queued: "排队中", submitting: "发送中" };
  for (const d of recent) lines.push(`${labelAt(d.updated_at, env.tz)}「${d.subject}」：${STATUS[d.status] ?? d.status}`);
  if (!recent.length) lines.push("最近没有任何邮件投递记录。");
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE type = 'reminder' AND status = 'failed'`).get() as { n: number };
  if (failed.n) lines.push(`有 ${failed.n} 个提醒任务执行失败，可以在设置页的投递记录里查看原因后手动重发。`);
  return lines.join("\n");
}

/** “为什么这样安排”：读出最近相关学习块自己的安排依据 */
function explainPlan(env: BindEnv): string {
  const active = activeSessions(env);
  const sel = env.selected?.kind === "plan_session" ? active.find((s) => s.id === env.selected!.id) : undefined;
  const list = sel ? [sel] : active.slice(0, 3);
  if (!list.length) return "现在没有已安排的学习块。";
  return list
    .map((s) => {
      const reason = (getDb().prepare(`SELECT reason FROM plan_sessions WHERE id = ?`).get(s.id) as { reason: string }).reason;
      return `${sessionLabel(s, env)}：${reason || "排在当时最早的可用空档"}`;
    })
    .join("\n");
}

function labelAt(iso: string, tz: string): string {
  const d = localDateInTz(new Date(iso), tz);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${t}`;
}

/** 一个事项里的意图 → 注册操作参数 / 一个具体问题 / 失败原因 */
export function bindIntents(intents: Intent[], env: BindEnv): Bound {
  if (!intents.length) return { kind: "fail", error: "没有可执行的内容" };
  if (intents.every(isPolicyIntent)) return mergePolicy(intents, env);
  // 多个对象的修改必须先拆成步骤（intake 的 splitSteps）；这里不静默只做第一个
  if (intents.length > 1) return { kind: "fail", error: "这条指令包含多个不同对象的修改，需要拆成步骤分别执行" };
  return bindOne(intents[0]!, env);
}

/** 拆步骤：连续的时间规则合并成一步，其余每个意图各一步；返回每步包含的意图下标（从 0 起） */
export function stepGroups(intents: Intent[]): number[][] {
  const groups: number[][] = [];
  intents.forEach((intent, i) => {
    const last = groups.at(-1);
    if (isPolicyIntent(intent) && last && isPolicyIntent(intents[last[0]!]!)) last.push(i);
    else groups.push([i]);
  });
  return groups;
}

/** 意图里引用的前序步骤（从 1 起的意图序号） */
export function stepRefsOf(intent: Intent): number[] {
  const out: number[] = [];
  const visit = (v: unknown) => {
    if (!v || typeof v !== "object") return;
    const o = v as Record<string, unknown>;
    if (o.kind === "step" && typeof o.step === "number") out.push(o.step);
    else for (const x of Object.values(o)) if (x && typeof x === "object") visit(x);
  };
  visit(intent);
  return out;
}

/** 完成表达要先确认真的对得上已有任务；对不上就不当指令，留给分类按一次实践处理 */
export function completionHasTarget(ref: Ref): boolean {
  if (ref.kind !== "named") return false;
  return matchTask(ref.text, openTasks()).kind !== "none";
}

// ===== 回答解析：按问题用途，不再统一要求“第N周” =====

export type AnswerParse = { ok: true; structured: Record<string, unknown> } | { ok: false; hint: string };

const YES_WORDS = new Set(["是", "是的", "好", "好的", "行", "可以", "嗯", "嗯嗯", "对", "对的", "确认", "同意", "没问题", "就这样", "那就这样", "按这个", "按这个来", "就按这个", "就按这个来", "按你说的", "要", "采用", "ok", "好呀", "好啊", "行啊", "可以啊", "可以呀", "按校历", "按校历修正"]);
const NO_WORDS = new Set(["不", "否", "不是", "先不", "先不要", "不要", "不用", "算了", "不行", "别", "先别", "不了", "不采用", "不同意", "先不改", "不改", "别改", "先不用"]);

/**
 * 确认类回答的整句判断：只有完整、无条件的“同意/不同意”才走零模型快路径。
 * 带条件、改正、疑问或犹豫的（“可以，但周末别动”“可以吗？我还没想好”）返回 null，交给整句理解，不按前缀截断。
 */
export function completeVerdict(text: string, options: string[] = []): "yes" | "no" | null {
  const t = text.trim();
  const exact = options.findIndex((o) => o.trim() === t);
  if (exact === 0) return "yes";
  if (exact === 1) return "no";
  if (!t || /[?？]/.test(t)) return null;
  const parts = t.split(/[，,。.！!~～\s]+/).map((p) => p.replace(/[吧啊呀啦哈了]+$/, "").toLowerCase()).filter(Boolean);
  if (!parts.length) return null;
  if (parts.every((p) => wholly(p, YES_WORDS))) return "yes";
  if (parts.every((p) => wholly(p, NO_WORDS) || wholly(p, YES_WORDS)) && wholly(parts[0]!, NO_WORDS)) return "no";
  return null;
}

/** 整段都能切成这类词（“嗯嗯可以”= 嗯嗯 + 可以）；剩下任何别的字都不算 */
function wholly(p: string, words: Set<string>): boolean {
  const ok: boolean[] = [true];
  for (let i = 1; i <= p.length; i++) ok[i] = [...words].some((w) => w.length <= i && ok[i - w.length] === true && p.slice(i - w.length, i) === w);
  return ok[p.length] === true;
}

function optionIndex(text: string, options: string[]): number {
  const t = text.trim();
  const ordinal = /^第?\s*(\d+|[一二两三四五六七八九十]+)\s*个?$/.exec(t);
  if (ordinal) {
    const n = parseNumber(ordinal[1]!);
    return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : -1;
  }
  const exact = options.findIndex((o) => o === t);
  if (exact >= 0) return exact;
  const m = matchTask(t, options.map((o, i) => ({ id: String(i), title: o })));
  return m.kind === "one" ? Number(m.task.id) : -1;
}

/** “补10月8日的课”“补周四的课”：源教学日通常就在目标日前后，按目标日所在年份/那一周理解，不往后推一年 */
function sourceDateFromText(text: string, target: string): string | null {
  const full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text);
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(text);
  const build = (y: number, m: number, d: number) => {
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? t.toISOString().slice(0, 10) : null;
  };
  if (full) return build(Number(full[1]), Number(full[2]), Number(full[3]));
  if (md) return build(Number(target.slice(0, 4)), Number(md[1]), Number(md[2]));
  const wd = /(上)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (wd) {
    const monday = addDays(target, -(isoWeekday(target) - 1));
    return addDays(monday, "一二三四五六日天".indexOf(wd[2]!) % 7 - (wd[1] ? 7 : 0));
  }
  return null;
}

export function parseAnswerByPurpose(q: QuestionRow, text: string, env: { referenceDate: string; now: Date; tz: string }): AnswerParse {
  const options = q.options ?? [];
  if (q.purpose === "agent_clarification") return { ok: true, structured: { text: text.trim() } };
  if (q.purpose === "entity_ref") {
    const candidates = (q.context.candidates as Array<{ kind: string; id: string; label: string }>) ?? [];
    const i = optionIndex(text, candidates.map((c) => c.label));
    return i >= 0 ? { ok: true, structured: { ref: { kind: candidates[i]!.kind, id: candidates[i]!.id } } } : { ok: false, hint: `回答序号或名称就行：${candidates.map((c, n) => `${n + 1}. ${c.label}`).join("；")}` };
  }
  if (q.purpose === "scope") {
    const choices = (q.context.choices as string[]) ?? [];
    const i = /以后|每个?|都|一直|长期/.test(text) ? choices.indexOf("always") : /只|这次|这个|这周|一次/.test(text) ? choices.indexOf("once") : optionIndex(text, options);
    return i >= 0 ? { ok: true, structured: { choice: choices[i] } } : { ok: false, hint: `回答其中一个：${options.join(" / ")}` };
  }
  if (q.purpose === "confirm") {
    const verdict = completeVerdict(text, options);
    if (verdict) return { ok: true, structured: { yes: verdict === "yes" } };
    // 方案确认：带条件/改正/犹豫的回答原样交给决策整句理解（修订同一目标），不当作同意
    if (q.context.revisable === true) return { ok: true, structured: { revise: true, text: text.trim() } };
    return { ok: false, hint: `这句带了条件或疑问，没法直接当作“${options[0] ?? "是"}”或“${options[1] ?? "不是"}”；请先回答其中一个，其他要求可以另外说` };
  }
  if (q.purpose === "routine") {
    const parsed = parseInstruction(text, env.referenceDate, env.now, env.tz);
    const policy = parsed.intents.map((i) => i.intent).filter(isPolicyIntent);
    if (policy.length) return { ok: true, structured: { intents: policy } };
    if (completeVerdict(text) === "yes" || /^(那)?(就)?(你|您)?(就)?按(你|您)?(的)?(推荐|建议)(的)?(来|安排|办)?(吧|就行)?[。！!]?$|^你(帮我|来)?(定|决定|安排)(吧|就行|就好)?[。！!]?$/.test(text.trim())) return { ok: true, structured: { intents: [{ op: "confirm_policy" }] } };
    return { ok: false, hint: "可以说“按你推荐的来”，或者告诉我晚上几点后不排、每天最多学多久、更适合晚上还是周末" };
  }
  if (q.purpose === "task_kind") {
    const i = optionIndex(text, options);
    // Negative phrases may contain “学习”: test them before the positive branch.
    if (/待办|只提醒|不排|不要排|不安排/.test(text) || i === 1) return { ok: true, structured: { taskKind: "todo" } };
    if (/学习|科研|项目|要排|安排学习/.test(text) || i === 0) return { ok: true, structured: { taskKind: "study" } };
    if (/决策|先决定|考虑/.test(text) || i === 2) return { ok: true, structured: { taskKind: "decision" } };
    return { ok: false, hint: "说“作为学习任务安排”“只记待办不排时间”或“先作为待决策”" };
  }
  if (q.purpose === "remaining") {
    if (isCompletionReport(text) || /^(已经?)?(做完|完成|搞定)/.test(text.trim())) return { ok: true, structured: { done: true } };
    const minutes = estimateFromText(text);
    if (minutes !== null) return { ok: true, structured: { minutes } };
    if (/不确定|不知道|不清楚|说不好|先.*梳理/.test(text)) return { ok: true, structured: { unknown: true } };
    return { ok: false, hint: "说一下大概还差多久（比如“还差一小时”），或者“不确定”“已经做完了”" };
  }
  if (q.purpose === "teaching_source") {
    if (/不清楚|不知道|不确定|没说|待定/.test(text)) return { ok: true, structured: { unknown: true } };
    const target = (q.context.targetDate as string | undefined) ?? env.referenceDate;
    const date = sourceDateFromText(text, target);
    if (date && date !== target) return { ok: true, structured: { sourceTeachingDate: date } };
    return { ok: false, hint: "说具体是补哪一天的课（如“补10月8日的课”），或者“不清楚”" };
  }
  if (q.purpose === "info") {
    const url = /https?:\/\/\S+/.exec(text)?.[0];
    return url ? { ok: true, structured: { url } } : { ok: false, hint: "贴一个链接；如果手上是通知原文或文件，直接放进上面的输入框就行" };
  }
  if (q.purpose === "session_feedback") return parseSessionFeedback(text, options);
  if (q.purpose === "tradeoff" || q.purpose === "conflict" || q.purpose === "locate") {
    const i = optionIndex(text, options);
    return i >= 0 ? { ok: true, structured: { choice: i } } : { ok: false, hint: `选一个：${options.map((o, n) => `${n + 1}. ${o}`).join("；")}` };
  }
  return { ok: false, hint: "这个问题暂时没法用这句话回答" };
}

const FEEDBACK_HINT = "说一下这段的结果就行：“做完了”“这段做完了，事情还没完”“没做”；只做了一部分就说“做了 40 分钟，还剩 30 分钟”";

/**
 * “这段做了吗，还剩多少？”的回答。outcome：task_done 整件事完成 / session_done 这段做了、事情没完 /
 * done 只说做完、没说范围（落实时按剩余需求判断）/ skipped 没做 / partial 做了一部分。
 * 只有主人说出口的分钟数才记成实际投入；说不清的回到提示，不猜。
 */
function parseSessionFeedback(text: string, options: string[]): AnswerParse {
  const t = text.trim();
  const ordinal = /^第?\s*(\d+|[一二两三])\s*个?$/.exec(t);
  const picked = ordinal ? parseNumber(ordinal[1]!) - 1 : options.indexOf(t);
  const outcomeByOption = ["task_done", "session_done", "skipped"][picked];
  if (outcomeByOption) return { ok: true, structured: { outcome: outcomeByOption } };
  const minutesAfter = (re: RegExp) => {
    const m = re.exec(t);
    return m ? estimateFromText(m[1]!) : null;
  };
  const remaining = minutesAfter(/(?:还剩|还差|剩下?|还要|还需要?)\s*(?:大概|大约|差不多|约)?([^，,。；;！!]*)/);
  const actual = minutesAfter(/(?:做了|学了|写了|花了|弄了|干了|看了|练了|用了)\s*(?:大概|大约|差不多|约)?([^，,。；;！!]*)/);
  const half = /(做|写|学|完成)(了|到)?一半/.test(t);
  const minutes = { ...(actual !== null ? { actualMinutes: actual } : {}), ...(remaining !== null ? { remainingMinutes: remaining } : {}) };
  const notAtAll = /没(有)?(做|学|写|开始|动|弄|去|碰)(?!完)|忘了|跳过|没时间|没空|鸽了/.test(t);
  const notFinished = half || /没(做|写|学|弄|干)?完|没完成|未完成|没结束|还没好|只做了|做了一部分|做了一些|做了点/.test(t);
  const doneWord = /(做|写|学|弄|干)完|完成|搞定|弄好|做好/.test(t);
  const sessionScoped = /(这段|这一段|这次|这块|这节)[^，,。；;]*((做|写|学|弄|干)完|完成|搞定)/.test(t);
  const taskScoped = /(都|全部|全都|整个|事情|任务|作业|这件事|这个事)[^，,。；;]*((做|写|学|弄|干)完|完成|搞定|交了)/.test(t);
  if (notAtAll && actual === null) return { ok: true, structured: { outcome: "skipped", ...minutes } };
  if (remaining === 0) return { ok: true, structured: { outcome: "task_done", ...minutes } };
  if (remaining !== null) return { ok: true, structured: { outcome: "partial", ...minutes } };
  const doneScope = sessionScoped ? (taskScoped && !notFinished ? "task_done" : "session_done") : taskScoped && !notFinished ? "task_done" : "done";
  if (actual !== null) return { ok: true, structured: { outcome: doneWord && (!notFinished || sessionScoped) ? doneScope : "partial", ...minutes } };
  if (sessionScoped) return { ok: true, structured: { outcome: doneScope } };
  if (notFinished) return { ok: false, hint: "这段做了大概多久、还剩多少？比如“做了 40 分钟，还剩 30 分钟”" };
  if (doneWord || isCompletionReport(t)) return { ok: true, structured: { outcome: doneScope } };
  if (/^(做了|学了|写了|弄了)[吧啊呀了。！!]*$/.test(t)) return { ok: true, structured: { outcome: "session_done" } };
  return { ok: false, hint: FEEDBACK_HINT };
}

/** 待反馈块的回答落实成现有操作；块已经有了结果（别处记过、挪走了）就不再写 */
function commandsForSessionFeedback(q: QuestionRow, structured: Record<string, unknown>, env: BindEnv): { commands: Array<Record<string, unknown>>; replanDates: string[]; note: string } {
  const sessionId = q.context.sessionId as string;
  const session = getSession(sessionId);
  if (!session || !["planned", "tentative", "in_progress"].includes(session.status) || Date.parse(session.endUtc) > env.now.getTime()) return { commands: [], replanDates: [], note: "这段已经有了结果或被挪走了，没有重复记录" };
  const planned = Math.round((Date.parse(session.endUtc) - Date.parse(session.startUtc)) / 60000);
  const actual = typeof structured.actualMinutes === "number" ? structured.actualMinutes : null;
  const remaining = typeof structured.remainingMinutes === "number" ? structured.remainingMinutes : null;
  let outcome = structured.outcome as string;
  if (outcome === "done") {
    // 只说“做完了”：这段是这件事最后一段、剩余需求它盖得住才算整件事完成；否则只记这一段
    const others = getDb().prepare(`SELECT 1 FROM plan_sessions WHERE task_id = ? AND id != ? AND status IN ('planned','tentative','in_progress')`).get(session.taskId, session.id);
    const demand = taskRemainingDemand(session.taskId, env.now);
    outcome = !others && demand !== null && demand <= planned ? "task_done" : "session_done";
  }
  const complete = { command: "set_session_state", sessionId, action: "complete", expectedVersion: session.version, actualMinutes: actual };
  const reportRemaining = remaining !== null && remaining > 0 ? [{ command: "create_or_update_task", taskId: session.taskId, remainingMinutes: remaining }] : [];
  if (outcome === "task_done") return { commands: [complete, { command: "complete_task", taskId: session.taskId }], replanDates: [], note: "" };
  if (outcome === "skipped") return { commands: [{ command: "set_session_state", sessionId, action: "skip", expectedVersion: session.version }, ...reportRemaining], replanDates: [], note: "这段记为没做，保留在记录里，按原来的需求重新安排" };
  if (outcome === "session_done") return { commands: [complete], replanDates: [], note: structured.outcome === "done" ? "这段记为完成；整件事有没有完成你没说，剩下的照常安排" : "" };
  return { commands: [complete, ...reportRemaining], replanDates: [], note: remaining !== null ? `剩下的 ${remaining} 分钟重新安排` : "按做了的时间扣掉，剩下的重新安排" };
}

/** 不挂在某份投递上的问题（作息、剩余需求、取舍、冲突）：回答后直接落实成操作 */
export function commandsForStandaloneAnswer(q: QuestionRow, structured: Record<string, unknown>, env: BindEnv): { commands: Array<Record<string, unknown>>; replanDates: string[]; note: string } {
  const taskId = q.context.taskId as string | undefined;
  if (q.purpose === "session_feedback") return commandsForSessionFeedback(q, structured, env);
  if (q.purpose === "routine") {
    const bound = mergePolicy((structured.intents as Intent[]) ?? [{ op: "confirm_policy" }], env);
    if (bound.kind !== "run") return { commands: [], replanDates: [], note: "" };
    return { commands: [{ ...bound.command, confirm: true }], replanDates: bound.replanDates ?? [], note: "" };
  }
  if (q.purpose === "task_kind" && taskId && typeof structured.taskKind === "string") return { commands: [{ command: "create_or_update_task", taskId, taskKind: structured.taskKind }], replanDates: [], note: structured.taskKind === "study" ? "已作为学习任务纳入安排" : "已保留在待处理中，不占用学习时间" };
  if (q.purpose === "remaining" && taskId) {
    if (structured.done) return { commands: [{ command: "complete_task", taskId }], replanDates: [], note: "" };
    if (typeof structured.minutes === "number") return { commands: [{ command: "create_or_update_task", taskId, remainingMinutes: structured.minutes }], replanDates: [], note: "" };
    // 不确定：只安排一次 25 分钟梳理，总量仍然未知
    return { commands: [{ command: "create_or_update_task", taskId, remainingMinutes: 25 }], replanDates: [], note: "先安排 25 分钟梳理，做完再看还差多少" };
  }
  if (q.purpose === "tradeoff" && taskId) {
    const choice = structured.choice as number;
    if (choice === 0) return { commands: [{ command: "create_or_update_task", taskId, remainingMinutes: Number(q.context.placedMinutes ?? 0) }], replanDates: [], note: "按截止前排得下的部分做" };
    if (choice === 1) {
      const until = (q.context.dueLocalDate as string | undefined) ?? env.referenceDate;
      const others = (q.context.deferrable as string[] | undefined) ?? [];
      return { commands: [...others.map((id) => ({ command: "pause_task", taskId: id, until: addDays(until, 1) })), { command: "create_or_update_task", taskId, priority: "high" }], replanDates: [], note: "" };
    }
    return { commands: [], replanDates: [], note: "好，这项你自己处理，我不动" };
  }
  if (q.purpose === "info" && typeof structured.url === "string" && typeof q.context.year === "number") {
    return { commands: [{ command: "update_calendar_sync_policy", holidayYear: q.context.year, holidayUrl: structured.url }], replanDates: [], note: "链接已记下，马上去核对" };
  }
  if (q.purpose === "conflict") {
    const sessionId = q.context.sessionId as string | undefined;
    if (structured.choice === 0 && sessionId) return { commands: [{ command: "set_session_state", sessionId, action: "skip" }], replanDates: [], note: "原来那段让出，另找时间" };
    return { commands: [], replanDates: [], note: "好，保留不动" };
  }
  return { commands: [], replanDates: [], note: "" };
}

// ===== 主动提问：只在影响安排的关键缺口上问，最多同时 3 个 =====

const MAX_OPEN_QUESTIONS = 3;
/** 待反馈问题单独计数：它们不挤掉截止/冲突问题，自己也最多同时 3 个、同一任务一次只问一段 */
const MAX_OPEN_FEEDBACK = 3;

function canAsk(): boolean {
  return listOpenQuestions().filter((q) => q.purpose !== "session_feedback").length < MAX_OPEN_QUESTIONS;
}

function slotLabel(ms: number, tz: string): string {
  const d = localDateInTz(new Date(ms), tz);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${t}`;
}

/**
 * 已经过去、没有反馈的学习块：每段一个持久问题“这段做了吗，还剩多少？”。
 * 问题键带块的结束时间——刷新、重排、重试都复用同一个；块被挪走后再过期才算新的一段。
 * 块已有结果（别处记过、挪走、任务结束）时收回问题。回答前排程只把这段挂着，不当完成也不整段补排。
 */
export function askSessionFeedback(env: { conversationId: string | null; tz: string }): QuestionRow[] {
  const db = getDb();
  const waiting = awaitingFeedbackSessions(nowDate());
  const waitingKeys = new Set(waiting.map((s) => `session.feedback:${s.id}:${s.endUtc}`));
  const open = listOpenQuestions().filter((q) => q.purpose === "session_feedback");
  for (const q of open) if (!waitingKeys.has(q.questionKey)) supersedeQuestion(q.id);
  const live = open.filter((q) => waitingKeys.has(q.questionKey));
  const busyTasks = new Set(live.map((q) => q.context.taskId as string));
  const asked: QuestionRow[] = [];
  for (const s of waiting) {
    if (live.length >= MAX_OPEN_FEEDBACK) break;
    if (busyTasks.has(s.taskId)) continue;
    const key = `session.feedback:${s.id}:${s.endUtc}`;
    if (questionEverAsked(key)) continue;
    const title = (db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(s.taskId) as { title: string }).title;
    const [start, end] = [Date.parse(s.startUtc), Date.parse(s.endUtc)];
    const { question } = ensureOpenQuestion({
      questionKey: key,
      intakeId: null,
      itemId: null,
      fieldPath: "session.feedback",
      prompt: `「${title}」${slotLabel(start, env.tz)}–${slotLabel(end, env.tz).slice(-5)} 这段已经过去了，还没记录结果。这段做了吗，还剩多少？没说之前我不会把它当成做完，也不会再整段补排。`,
      options: ["做完了，这件事也完了", "这段做完了，事情还没完", "没做，帮我另排"],
      purpose: "session_feedback",
      reason: "这段的执行情况只有你知道：不问清楚，排程既不能当它做了，也不能当它没做",
      context: { sessionId: s.id, taskId: s.taskId, plannedMinutes: Math.round((end - start) / 60000), startUtc: s.startUtc, endUtc: s.endUtc },
      conversationId: env.conversationId,
    });
    live.push(question);
    busyTasks.add(s.taskId);
    asked.push(question);
  }
  return asked;
}

/**
 * 首次有课表、作息还是暂定时：根据课程先给一个可讨论的建议，只问一个影响预算的关键条件。
 * 不重复问课程里已有的事实；回答“按你推荐的来”即可。
 */
export function maybeAskRoutine(env: { intakeId: string | null; conversationId: string | null; referenceDate: string; tz: string }): QuestionRow | null {
  const key = "planning.routine";
  const prefs = getPrefs();
  if (prefs.status !== "tentative" || questionEverAsked(key) || !canAsk()) return null;
  // 找本周课最满的一天，建议当天少排
  let busiest: { weekday: number; minutes: number } | null = null;
  const monday = addDays(env.referenceDate, -(isoWeekday(env.referenceDate) - 1));
  for (let i = 0; i < 7; i++) {
    const day = calendarDay(addDays(monday, i), env.tz);
    const minutes = Math.round(day.courses.reduce((a, c) => a + (c.interval[1] - c.interval[0]), 0) / 60000);
    if (!busiest || minutes > busiest.minutes) busiest = { weekday: i + 1, minutes };
  }
  if (!busiest || busiest.minutes === 0) return null;
  const meals = prefs.meals.map(([s, e]) => `${s}–${e}`).join("、");
  const prompt = [
    `周${WEEKDAY[busiest.weekday - 1]}课最满（${busiest.minutes} 分钟），那天我只会排一段轻量的；需要整块时间的放到课少的日子或周末。`,
    `暂定的作息：工作日 ${prefs.workdayStart}–${prefs.workdayEnd}、周末 ${prefs.weekendStart}–${prefs.weekendEnd} 可以安排；三餐（${meals}）和课前后 ${prefs.commuteMinutes} 分钟留出来；每天最多 ${prefs.dailyLimitMinutes} 分钟，再留 ${prefs.bufferPercent}% 机动。`,
    "你晚上一般几点后不希望再安排学习？也可以直接说“按你推荐的来”，或一句话改掉其中任何一条。",
  ].join("\n");
  const { question } = ensureOpenQuestion({
    questionKey: key,
    intakeId: env.intakeId,
    itemId: null,
    fieldPath: "planning.preferences",
    prompt,
    options: ["按你推荐的来", "晚上十点后不排", "晚上十一点后不排"],
    purpose: "routine",
    reason: "这决定每天能排多少学习、排在什么时候；不确认我只能给暂定安排",
    context: { busiestWeekday: busiest.weekday },
    conversationId: env.conversationId,
  });
  return question;
}

/** 重排后还有“必须问主人才能继续”的缺口：剩余需求未知、截止前排不下、近期安排有冲突 */
export function raisePlanQuestions(plan: Pick<RebuildResult, "unscheduled" | "conflicts">, env: { conversationId: string | null; tz: string }): QuestionRow[] {
  const db = getDb();
  const asked: QuestionRow[] = askSessionFeedback(env);
  const pendingUnknown = new Set(pendingTasks().filter((t) => t.kind === "unknown").map((t) => t.taskId));
  for (const q of listOpenQuestions()) {
    const taskId = q.context.taskId as string | undefined;
    if (!taskId) continue;
    if ((q.purpose === "task_kind" && !pendingUnknown.has(taskId)) || (["remaining", "tradeoff"].includes(q.purpose) && !taskAdmitted(taskId))) supersedeQuestion(q.id);
  }
  const label = (ms: number) => slotLabel(ms, env.tz);
  // 按影响排序：截止不可达 → 近期冲突 → 剩余需求未知
  for (const u of plan.unscheduled.filter((x) => x.reason === "deadline_unfeasible")) {
    if (!canAsk()) return asked;
    const task = db.prepare(`SELECT title, due_at, due_local_date FROM tasks WHERE id = ?`).get(u.taskId) as { title: string; due_at: string | null; due_local_date: string | null } | undefined;
    if (!task) continue;
    const key = `task.deadline:${u.taskId}:${u.missingMinutes ?? 0}`;
    if (questionEverAsked(key)) continue;
    const placed = (db.prepare(`SELECT COALESCE(SUM((julianday(end_utc) - julianday(start_utc)) * 1440), 0) AS m FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative','in_progress')`).get(u.taskId) as { m: number }).m;
    const deferrable = (db.prepare(`SELECT id, title FROM tasks WHERE status IN ('todo','doing') AND archived_at IS NULL AND due_kind = 'none' AND id != ? AND (paused_until IS NULL OR paused_until <= ?) ORDER BY created_at LIMIT 3`).all(u.taskId, localDateInTz(nowDate(), env.tz)) as TaskRef[]);
    const due = task.due_at ? label(Date.parse(task.due_at)) : task.due_local_date;
    const options = [`缩小范围，按排得下的 ${Math.round(placed)} 分钟做`, deferrable.length ? `先暂缓${deferrable.map((d) => `「${d.title}」`).join("")}，优先这项` : "把这项设为最优先", "我自己处理"];
    const { question } = ensureOpenQuestion({
      questionKey: key,
      intakeId: null,
      itemId: null,
      fieldPath: "task.tradeoff",
      prompt: `「${task.title}」${due} 截止，按现在的课程和预算还缺 ${u.missingMinutes} 分钟。截止不会自动顺延，你想怎么处理？`,
      options,
      purpose: "tradeoff",
      reason: "截止前排不下，需要你做取舍",
      context: { taskId: u.taskId, placedMinutes: Math.round(placed), deferrable: deferrable.map((d) => d.id), dueLocalDate: task.due_at ? localDateInTz(new Date(task.due_at), env.tz) : task.due_local_date },
      conversationId: env.conversationId,
    });
    asked.push(question);
  }
  for (const c of plan.conflicts) {
    if (!canAsk()) return asked;
    const key = `session.conflict:${c.sessionId}:${c.reason}`;
    if (questionEverAsked(key)) continue;
    const s = db.prepare(`SELECT s.start_utc, t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`).get(c.sessionId) as { start_utc: string; title: string } | undefined;
    if (!s) continue;
    const why = c.reason === "overlaps_fixed" ? "和课程/固定活动撞了" : c.reason === "outside_policy" ? "落在你说不安排学习的时段" : "超出了当天的学习预算";
    const { question } = ensureOpenQuestion({
      questionKey: key,
      intakeId: null,
      itemId: null,
      fieldPath: "session.conflict",
      prompt: `${label(Date.parse(s.start_utc))} 的「${s.title}」${why}。这段离现在不到一天（或是你锁定的），我没有擅自动它。要我另找时间吗？`,
      options: ["帮我另找时间", "保留不动"],
      purpose: "conflict",
      reason: "近期或锁定的安排不会被自动移动",
      context: { sessionId: c.sessionId, taskId: c.taskId, conflict: c.reason },
      conversationId: env.conversationId,
    });
    asked.push(question);
  }
  for (const u of plan.unscheduled.filter((x) => x.reason === "needs_remaining_estimate" || x.reason === "unknown_requirement")) {
    if (!canAsk()) return asked;
    const key = `task.remaining:${u.taskId}`;
    if (db.prepare(`SELECT 1 FROM clarification_questions WHERE question_key = ? AND status = 'open'`).get(key)) continue;
    // 起步块还没做的未知任务不追问：先让那 25 分钟发生
    if (u.reason === "unknown_requirement" && !db.prepare(`SELECT 1 FROM plan_sessions WHERE task_id = ? AND status IN ('completed','skipped')`).get(u.taskId) && !db.prepare(`SELECT 1 FROM practice_entries WHERE task_id = ?`).get(u.taskId)) continue;
    const { question } = ensureOpenQuestion({
      questionKey: key,
      intakeId: null,
      itemId: null,
      fieldPath: "task.remaining",
      prompt: `「${u.title}」已经投入过一些时间，还没完成。大概还差多久？不确定的话，我先安排一次 25 分钟梳理。`,
      options: ["还差半小时", "还差一小时", "不确定，先排 25 分钟梳理", "已经做完了"],
      purpose: "remaining",
      reason: "花了多久不能直接推出完成了多少，需要你说一下剩余",
      context: { taskId: u.taskId },
      conversationId: env.conversationId,
    });
    asked.push(question);
  }
  // Ask only ambiguous admission; notices/errands/decisions need no duration question.
  for (const item of pendingTasks().filter((t) => t.kind === "unknown")) {
    if (!canAsk()) break;
    const key = `task.admission:${item.taskId}`;
    if (questionEverAsked(key)) continue;
    const { question } = ensureOpenQuestion({ questionKey: key, intakeId: null, itemId: null,
      fieldPath: "task.taskKind", purpose: "task_kind", conversationId: env.conversationId,
      prompt: `「${item.title}」是要投入学习 / 项目时间，还是只记待办、先做决策？确认前我不会给它排学习块。`,
      options: ["作为学习任务安排", "只记待办，不排时间", "先作为待决策"],
      reason: "需要确认投入意图，截止或工作量本身不代表要安排学习", context: { taskId: item.taskId } });
    asked.push(question);
  }
  return asked;
}
