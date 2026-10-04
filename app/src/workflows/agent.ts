import { getDb } from "@/repositories/db";
import type { Intent, Ref } from "@/domain/intent";
import { parseInstruction } from "@/domain/intent";
import { estimateFromText, isCompletionReport, matchTask, parseNumber, type TaskRef } from "@/domain/task-text";
import { addDays, localDateInTz, wallTimeToUtc } from "@/domain/time";
import { isoWeekday } from "@/domain/day-policy";
import { nowDate } from "@/domain/clock";
import { agentTurnsBefore, type EntityRef } from "@/repositories/conversations";
import { activePolicyRules } from "@/repositories/calendar-facts";
import { getBatch } from "@/repositories/journal";
import { getPrefs } from "@/repositories/plan";
import { ensureOpenQuestion, listOpenQuestions, questionEverAsked, type QuestionRow } from "@/repositories/questions";
import { calendarDay } from "@/workflows/calendar";
import type { RebuildResult } from "@/workflows/plan";

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
};

export type QuestionSpec = { key: string; purpose: string; fieldPath: string; prompt: string; reason: string; options: string[]; context: Record<string, unknown> };

export type Bound =
  | { kind: "run"; command: Record<string, unknown>; replanDates?: string[] }
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

/** 对话里最近提到的对象（新→旧），外加从卡片带来的选中对象 */
function recentRefs(env: BindEnv): EntityRef[] {
  const out: EntityRef[] = env.selected ? [env.selected] : [];
  if (env.conversationId) for (const turn of agentTurnsBefore(env.conversationId, env.intakeId)) out.push(...turn.refs);
  return out;
}

type Resolved<T> = { kind: "one"; value: T } | { kind: "many"; values: T[] } | { kind: "none"; why: string };

function resolveSession(ref: Ref, env: BindEnv): Resolved<SessionCand> {
  const active = activeSessions(env);
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
  if (ref.kind === "recent") {
    for (const r of recentRefs(env)) {
      const id = r.kind === "task" ? r.id : r.kind === "plan_session" ? (getDb().prepare(`SELECT task_id FROM plan_sessions WHERE id = ?`).get(r.id) as { task_id: string } | undefined)?.task_id : undefined;
      const hit = tasks.find((t) => t.id === id);
      if (hit) return { kind: "one", value: hit };
    }
    return { kind: "none", why: "不确定你说的是哪个任务，说一下名称" };
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
      patch.base.workdayEnd = i.time;
      patch.base.weekendEnd = i.time;
      patch.confirm = true;
    } else if (i.op === "window_start") {
      patch.base.workdayStart = i.time;
      patch.base.weekendStart = i.time;
      patch.confirm = true;
    } else if (i.op === "holiday_policy") patch.rules.push({ kind: "holiday_policy", scope: "persistent", value: { mode: i.mode, ...(i.mode === "reduced" ? { limitMinutes: 60 } : {}) } });
    else if (i.op === "prefer_window") patch.rules.push({ kind: "preferred_window", scope: "persistent", value: { part: i.part } });
    else if (i.op === "confirm_policy") patch.confirm = true;
    else if (i.op === "replan") {
      // 授权只覆盖说到的那几天里未锁定、未开始的学习安排；课程、截止、锁定块都不在范围内
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
  // 以下都针对任务
  if (intent.op === "pause_task" || intent.op === "resume_task" || intent.op === "prioritize" || intent.op === "set_due" || intent.op === "remaining" || intent.op === "complete") {
    const t = chooseOrAsk(resolveTask(intent.ref, env), env, "task", (v) => v.title, "任务");
    if (t.kind !== "one") return t;
    const taskId = t.value.id;
    if (intent.op === "pause_task") return { kind: "run", command: { command: "pause_task", taskId, until: intent.until } };
    if (intent.op === "resume_task") return { kind: "run", command: { command: "pause_task", taskId, resume: true } };
    if (intent.op === "prioritize") return { kind: "run", command: { command: "create_or_update_task", taskId, priority: "high" } };
    if (intent.op === "set_due") return { kind: "run", command: { command: "create_or_update_task", taskId, dueLocalDate: intent.dueLocalDate, dueLocalTime: intent.dueLocalTime } };
    if (intent.op === "remaining") return { kind: "run", command: { command: "create_or_update_task", taskId, remainingMinutes: intent.minutes } };
    return { kind: "run", command: { command: "complete_task", taskId, occurredOn: env.referenceDate, actualMinutes: intent.actualMinutes } };
  }
  return { kind: "fail", error: "这条指令现在还处理不了" };
}

/** 一个事项里的意图 → 注册操作参数 / 一个具体问题 / 失败原因 */
export function bindIntents(intents: Intent[], env: BindEnv): Bound {
  if (!intents.length) return { kind: "fail", error: "没有可执行的内容" };
  if (intents.every(isPolicyIntent)) return mergePolicy(intents, env);
  return bindOne(intents[0]!, env);
}

/** 完成表达要先确认真的对得上已有任务；对不上就不当指令，留给分类按一次实践处理 */
export function completionHasTarget(ref: Ref): boolean {
  if (ref.kind !== "named") return false;
  return matchTask(ref.text, openTasks()).kind !== "none";
}

// ===== 回答解析：按问题用途，不再统一要求“第N周” =====

export type AnswerParse = { ok: true; structured: Record<string, unknown> } | { ok: false; hint: string };

const YES = /^(是|好|好的|行|可以|嗯|对|确认|同意|没问题|就这样|按校历|按这个|要)/;
const NO = /^(不|否|先不|别|不要|不用|算了|不行)/;

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

export function parseAnswerByPurpose(q: QuestionRow, text: string, env: { referenceDate: string; now: Date; tz: string }): AnswerParse {
  const options = q.options ?? [];
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
    if (YES.test(text.trim())) return { ok: true, structured: { yes: true } };
    if (NO.test(text.trim())) return { ok: true, structured: { yes: false } };
    return { ok: false, hint: "回答“可以”或“先不要”" };
  }
  if (q.purpose === "routine") {
    const parsed = parseInstruction(text, env.referenceDate, env.now, env.tz);
    const policy = parsed.intents.map((i) => i.intent).filter(isPolicyIntent);
    if (policy.length) return { ok: true, structured: { intents: policy } };
    if (YES.test(text.trim()) || /推荐|建议|你(帮我|来)?(定|决定|安排)/.test(text)) return { ok: true, structured: { intents: [{ op: "confirm_policy" }] } };
    return { ok: false, hint: "可以说“按你推荐的来”，或者告诉我晚上几点后不排、每天最多学多久、更适合晚上还是周末" };
  }
  if (q.purpose === "remaining") {
    if (isCompletionReport(text) || /^(已经?)?(做完|完成|搞定)/.test(text.trim())) return { ok: true, structured: { done: true } };
    const minutes = estimateFromText(text);
    if (minutes !== null) return { ok: true, structured: { minutes } };
    if (/不确定|不知道|不清楚|说不好|先.*梳理/.test(text)) return { ok: true, structured: { unknown: true } };
    return { ok: false, hint: "说一下大概还差多久（比如“还差一小时”），或者“不确定”“已经做完了”" };
  }
  if (q.purpose === "tradeoff" || q.purpose === "conflict") {
    const i = optionIndex(text, options);
    return i >= 0 ? { ok: true, structured: { choice: i } } : { ok: false, hint: `选一个：${options.map((o, n) => `${n + 1}. ${o}`).join("；")}` };
  }
  return { ok: false, hint: "这个问题暂时没法用这句话回答" };
}

/** 不挂在某份投递上的问题（作息、剩余需求、取舍、冲突）：回答后直接落实成操作 */
export function commandsForStandaloneAnswer(q: QuestionRow, structured: Record<string, unknown>, env: BindEnv): { commands: Array<Record<string, unknown>>; replanDates: string[]; note: string } {
  const taskId = q.context.taskId as string | undefined;
  if (q.purpose === "routine") {
    const bound = mergePolicy((structured.intents as Intent[]) ?? [{ op: "confirm_policy" }], env);
    if (bound.kind !== "run") return { commands: [], replanDates: [], note: "" };
    return { commands: [{ ...bound.command, confirm: true }], replanDates: bound.replanDates ?? [], note: "" };
  }
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
  if (q.purpose === "conflict") {
    const sessionId = q.context.sessionId as string | undefined;
    if (structured.choice === 0 && sessionId) return { commands: [{ command: "set_session_state", sessionId, action: "skip" }], replanDates: [], note: "原来那段让出，另找时间" };
    return { commands: [], replanDates: [], note: "好，保留不动" };
  }
  return { commands: [], replanDates: [], note: "" };
}

// ===== 主动提问：只在影响安排的关键缺口上问，最多同时 3 个 =====

const MAX_OPEN_QUESTIONS = 3;

function canAsk(): boolean {
  return listOpenQuestions().length < MAX_OPEN_QUESTIONS;
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
  const asked: QuestionRow[] = [];
  const label = (ms: number) => {
    const d = localDateInTz(new Date(ms), env.tz);
    const t = new Intl.DateTimeFormat("en-GB", { timeZone: env.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
    return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${t}`;
  };
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
  return asked;
}
