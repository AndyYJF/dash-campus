import { z } from "zod";
import { taskKindSchema } from "@/domain/task-admission";
import { addDays } from "./time";
import { dateFromText, estimateFromText, isCompletionReport, parseNumber, timeFromText } from "./task-text";
import { normalizeProfileValue, profileFactsFromText } from "./identity";
import { isReadRequest } from "./read-request";

/**
 * 主人指令的结构化意图（REPAIR-PLAN §5.1.1，AGENT-INTERFACE-CONTRACT §5.1）。
 * 这里只把“说了什么”变成有类型的意图：对象仍是文字引用，最终绑定哪个 ID 由服务端核对；
 * 模型输出的意图用同一个 schema 校验，和确定性解析走同一条绑定/执行通路。
 * 解析不了就不认，交给后面的分类，不猜。
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const part = z.enum(["morning", "afternoon", "evening", "any"]);

/** 可以按 ID 引用的对象种类 */
export const REF_ENTITY_KINDS = ["task", "plan_session", "project", "goal", "practice_entry", "resource", "candidate", "fixed_event", "inbox_message", "course_set", "exploration_topic"] as const;

/**
 * 对象引用：recent = “刚才那个”；named = 名称 + 可选的日期/时段限定；
 * id = 已经见过的对象（选中卡片、对话里出现过、只读工具返回过），没见过的 ID 一律拒绝；
 * step = 同一句话里第 N 个意图（从 1 起）产生的对象，前一步完成后才绑定。
 */
export const refSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recent") }),
  z.object({ kind: z.literal("named"), text: z.string().min(1).max(100), date: dateStr.nullable().default(null), part: part.default("any") }),
  z.object({ kind: z.literal("id"), entityKind: z.enum(REF_ENTITY_KINDS), id: z.string().min(1).max(64) }),
  z.object({ kind: z.literal("step"), step: z.number().int().min(1).max(8) }),
]);
export type Ref = z.infer<typeof refSchema>;

export const intentSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("inspect"), query: z.string().min(1).max(2000) }),
  z.object({ op: z.literal("undo") }),
  z.object({ op: z.literal("move_session"), ref: refSchema, targetDate: dateStr.nullable().default(null), part: part.default("any"), startLocalTime: timeStr.nullable().default(null) }),
  z.object({ op: z.literal("shorten_session"), ref: refSchema, durationMinutes: z.number().int().min(5).max(240) }),
  z.object({ op: z.literal("no_study"), dateFrom: dateStr, dateTo: dateStr, fromTime: timeStr.nullable().default(null), label: z.string().max(40).default("不安排学习") }),
  z.object({ op: z.literal("weekday_limit"), weekday: z.number().int().min(1).max(7), limitMinutes: z.number().int().min(0).max(960), persistent: z.boolean() }),
  z.object({ op: z.literal("group_limit"), group: z.enum(["workday", "weekend"]), limitMinutes: z.number().int().min(0).max(960) }),
  z.object({ op: z.literal("daily_limit"), limitMinutes: z.number().int().min(0).max(960) }),
  z.object({ op: z.literal("date_limit"), date: dateStr, limitMinutes: z.number().int().min(0).max(960) }),
  z.object({ op: z.literal("window_end"), time: timeStr }),
  z.object({ op: z.literal("window_start"), time: timeStr }),
  z.object({ op: z.literal("holiday_policy"), mode: z.enum(["weekend_template", "reduced", "none"]) }),
  z.object({ op: z.literal("prefer_window"), part: z.enum(["morning", "afternoon", "evening", "weekend"]) }),
  z.object({ op: z.literal("replan"), dateFrom: dateStr, dateTo: dateStr }),
  z.object({ op: z.literal("revoke_replan") }),
  z.object({ op: z.literal("confirm_policy") }),
  z.object({ op: z.literal("pause_task"), ref: refSchema, until: dateStr.nullable().default(null) }),
  z.object({ op: z.literal("resume_task"), ref: refSchema }),
  z.object({ op: z.literal("classify_task"), ref: refSchema, taskKind: taskKindSchema }),
  z.object({ op: z.literal("prioritize"), ref: refSchema }),
  z.object({ op: z.literal("set_due"), ref: refSchema, dueLocalDate: dateStr, dueLocalTime: timeStr.nullable().default(null) }),
  z.object({ op: z.literal("remaining"), ref: refSchema, minutes: z.number().int().min(0).max(100_000) }),
  z.object({ op: z.literal("complete"), ref: refSchema, actualMinutes: z.number().int().min(1).max(1440).nullable().default(null) }),
  z.object({ op: z.literal("correct_practice"), minutes: z.number().int().min(1).max(1440) }),
  z.object({ op: z.literal("goal"), title: z.string().min(1).max(200), horizon: z.enum(["long_term", "semester"]).default("semester"), primary: z.boolean().default(true) }),
  z.object({ op: z.literal("trial"), ref: refSchema, ordinal: z.number().int().min(1).max(10).nullable().default(null), weeks: z.number().int().min(1).max(12).default(2), commit: z.boolean().default(false) }),
  z.object({ op: z.literal("project_state"), ref: refSchema, status: z.enum(["active", "paused", "completed"]).nullable().default(null), commit: z.boolean().default(false) }),
  z.object({ op: z.literal("explore"), query: z.string().min(1).max(500) }),
  z.object({ op: z.literal("resource_link"), projectText: z.string().min(1).max(100) }),
  z.object({ op: z.literal("resource_role"), role: z.enum(["reference", "requirement", "achievement"]) }),
  z.object({ op: z.literal("profile"), facts: z.array(z.object({ field: z.enum(["education_level", "program", "campus", "grade_year", "study_year"]), value: z.string().min(1).max(200) })).min(1).max(5) }),
  z.object({ op: z.literal("notice_filter"), field: z.enum(["education_level", "program", "campus", "grade_year", "study_year"]), value: z.string().min(1).max(200), remove: z.boolean().default(false) }),
  z.object({ op: z.literal("explain"), topic: z.enum(["reminders", "plan"]) }),
  z.object({ op: z.literal("export") }),
  z.object({ op: z.literal("schedule_here"), text: z.string().min(1).max(200), date: dateStr, start: timeStr, end: timeStr }),
  z.object({
    op: z.literal("agent_policy"),
    dailyModelCalls: z.number().int().min(0).max(1000).optional(),
    scheduledEnabled: z.boolean().optional(),
    weeklyReview: z.object({ weekday: z.number().int().min(1).max(7), localTime: timeStr }).nullable().optional(),
  }),
  z.object({ op: z.literal("review"), week: z.enum(["last", "this"]) }),
  z.object({ op: z.literal("explore_topic"), title: z.string().min(1).max(200), weekday: z.number().int().min(1).max(7).optional(), localTime: timeStr.optional(), stop: z.boolean().default(false) }),
  z.object({ op: z.literal("digest_now"), kind: z.enum(["daily", "weekly"]) }),
  z.object({ op: z.literal("cancel_intake") }),
  z.object({ op: z.literal("fixed_event"), name: z.string().min(1).max(200), weekday: z.number().int().min(1).max(7).optional(), start: timeStr.optional(), end: timeStr.optional(), remove: z.boolean().default(false), skipDate: dateStr.optional() }),
  z.object({ op: z.literal("digest"), dailyEnabled: z.boolean().optional(), dailyTime: timeStr.optional(), weekdaysOnly: z.boolean().optional(), weeklyEnabled: z.boolean().optional(), weeklyWeekday: z.number().int().min(1).max(7).optional(), weeklyTime: timeStr.optional() }),
  z.object({ op: z.literal("reminders"), enabled: z.boolean().optional(), quietStart: timeStr.optional(), quietEnd: timeStr.optional() }),
  z.object({ op: z.literal("task_reminder"), ref: refSchema, leadMinutes: z.number().int().min(0).max(525_600) }),
  z.object({ op: z.literal("calendar_sync"), enabled: z.boolean(), intervalDays: z.number().int().min(1).max(30).nullable().default(null) }),
  z.object({ op: z.literal("course_cancel"), courseName: z.string().max(100).nullable().default(null), date: dateStr }),
  z.object({ op: z.literal("course_move"), courseName: z.string().max(100).nullable().default(null), sourceDate: dateStr, targetDate: dateStr, startLocalTime: timeStr.nullable().default(null) }),
  z.object({
    op: z.literal("create_task"),
    title: z.string().trim().min(1).max(200),
    taskKind: taskKindSchema.optional(),
    estimateMinutes: z.number().int().min(1).max(100_000).nullable().default(null),
    dueLocalDate: dateStr.nullable().default(null),
    dueLocalTime: timeStr.nullable().default(null),
    priority: z.enum(["normal", "high"]).default("normal"),
    projectRef: refSchema.nullable().default(null),
  }),
  z.object({
    op: z.literal("practice"),
    occurredOn: dateStr,
    actualMinutes: z.number().int().min(1).max(1440).nullable().default(null),
    note: z.string().max(500).default(""),
    category: z.enum(["study", "other"]).default("study"),
    taskRef: refSchema.nullable().default(null),
    projectRef: refSchema.nullable().default(null),
    blocker: z.string().max(500).default(""),
  }),
  z.object({ op: z.literal("schedule_at"), taskRef: refSchema.nullable().default(null), title: z.string().trim().min(1).max(200).nullable().default(null), date: dateStr, startLocalTime: timeStr, durationMinutes: z.number().int().min(5).max(240) }),
  z.object({ op: z.literal("session_state"), ref: refSchema, action: z.enum(["start", "complete", "skip", "lock", "unlock"]), actualMinutes: z.number().int().min(1).max(1440).nullable().default(null) }),
  z.object({ op: z.literal("resolve_notice"), ref: refSchema, partition: z.enum(["action", "info", "opportunity", "review", "folded"]) }),
  z.object({ op: z.literal("archive"), entityKind: z.enum(["task", "goal", "course_set", "project", "resource", "fixed_event", "practice_entry", "plan_session"]), ref: refSchema }),
]);
export type Intent = z.infer<typeof intentSchema>;

export type ParsedInstruction = { intents: Array<{ intent: Intent; clause: string }>; rest: string };

const PART_WORDS: Array<[RegExp, z.infer<typeof part>]> = [
  [/上午|早上|早晨|明早|今早/, "morning"],
  [/下午|午后/, "afternoon"],
  [/晚上|今晚|明晚|晚间|夜里|傍晚/, "evening"],
];
const WEEKDAY_INDEX: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 };
const DATE_WORD = String.raw`大后天|后天|明天|明日|明早|明晚|今天|今日|今晚|今早|(?:下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{4}-\d{2}-\d{2}`;
const NUM = String.raw`\d+(?:\.\d+)?|[一二两三四五六七八九十半]+`;
const DURATION = String.raw`(?:${NUM})\s*(?:个)?\s*(?:半)?\s*(?:小时|钟头|分钟|刻钟)(?:半)?`;

function partOf(text: string): z.infer<typeof part> {
  for (const [re, p] of PART_WORDS) if (re.test(text)) return p;
  return "any";
}

function hhmm(now: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
}

/** 去掉日期、时段、口头词后剩下的对象名称 */
function nameOf(text: string): string {
  return text
    .replace(new RegExp(DATE_WORD, "g"), "")
    .replace(/上午|早上|早晨|下午|午后|晚上|晚间|夜里|傍晚|中午/g, "")
    .replace(/^(把|将|我的?|那个|这个|这次|那次|这一次|的)+/, "")
    .replace(/(的|这次|那次|这个|那个|安排|学习块|任务)+$/, "")
    .replace(/[\s，。,.!！、:：]/g, "")
    .trim();
}

/** 指令里的对象名都很短；一长串正文（通知、资料）里碰巧出现“优先”“暂停”不算指令 */
function isShortName(subject: string): boolean {
  const n = nameOf(subject).length;
  return n >= 2 && n <= 12 && !/[：:]/.test(subject);
}

function refOf(subject: string, referenceDate: string): Ref {
  if (/^(这条|那条|这项|那项|这段|那段)$/.test(subject.trim())) return { kind: "recent" };
  if (/刚才|刚刚|上一个|上面那个|那个$|^那个|^它$|^这个$|^这条$|^那条$|^这项$|^那项$/.test(subject) && nameOf(subject.replace(/刚才|刚刚|上一个|上面/g, "")).length < 2) return { kind: "recent" };
  const text = nameOf(subject);
  if (!text) return { kind: "recent" };
  return { kind: "named", text, date: dateFromText(subject, referenceDate), part: partOf(subject) };
}

/** “晚上十点”“10点半”：没有上午/下午限定且不超过 12 点的，在“几点后不排”的语境下按晚上理解 */
function eveningTime(text: string): string | null {
  const t = timeFromText(text);
  if (!t) return null;
  const h = Number(t.slice(0, 2));
  return !/上午|早上|中午|下午|晚上|傍晚/.test(text) && h >= 6 && h <= 11 ? `${String(h + 12).padStart(2, "0")}${t.slice(2)}` : t;
}

function durationOf(text: string): number | null {
  return estimateFromText(text);
}

function untilOf(text: string, referenceDate: string): string | null {
  const span = new RegExp(`(${NUM})\\s*(?:个)?\\s*(天|周|星期|礼拜|个?月)`).exec(text);
  if (span) {
    const n = span[1] === "半" ? 0.5 : parseNumber(span[1]!);
    if (!Number.isNaN(n)) return addDays(referenceDate, Math.round(n * (span[2] === "天" ? 1 : /月/.test(span[2]!) ? 30 : 7)));
  }
  return dateFromText(text, referenceDate);
}

/** 钟点里的“下午/晚上”换成 24 小时制 */
function clock(text: string): string | null {
  const raw = timeFromText(text);
  if (!raw) return null;
  const h = Number(raw.slice(0, 2));
  return /晚|傍晚|下午/.test(text) && h < 12 ? `${String(h + 12).padStart(2, "0")}${raw.slice(2)}` : raw;
}

/** 已有的非课程固定活动：长期改时间或以后不去。只改某一次的说法不在这里认（留给后面的规则或分类） */
function fixedEventIntent(c: string, titles: string[], referenceDate: string): Intent | null {
  const name = titles.filter((t) => t.length >= 2 && c.includes(t)).sort((a, b) => b.length - a.length)[0];
  if (!name) return null;
  const tail = c.slice(c.indexOf(name) + name.length);
  const once = /(今天|明天|后天|今晚|明晚|这次|这一次|本周|这周|下周|这个?星期|下个?星期|\d+\s*[月/]\s*\d+)/.test(c);
  if (/(不去|不参加|不上|退出|退了|删掉|删除|去掉|取消)/.test(c) && !/(提醒|通知)/.test(c)) {
    if (!once) return { op: "fixed_event", name, remove: true };
    // 只是某一次不去：那一天不占用，规则不变
    const date = dateFromText(c, referenceDate);
    return date ? { op: "fixed_event", name, remove: false, skipDate: date } : null;
  }
  const move = /(?:改|换|挪|调|移)(?:到|成|为|至)(.+)$/.exec(tail);
  if (!move || once) return null;
  const target = move[1]!;
  const wd = /(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(target);
  const range = /(\d{1,2}\s*[:：]\s*\d{2})\s*(?:-|–|—|~|到|至)\s*(\d{1,2}\s*[:：]\s*\d{2})/.exec(target);
  const start = range ? timeFromText(range[1]!) : clock(target);
  const end = range ? timeFromText(range[2]!) : null;
  if (!wd && !start) return null;
  return { op: "fixed_event", name, remove: false, ...(wd ? { weekday: WEEKDAY_INDEX[wd[1]!]! } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) };
}

export type ParseHints = { fixedEventTitles?: string[] };

function parseClause(clause: string, referenceDate: string, now: Date, tz: string, hints: ParseHints = {}): Intent | "ignore" | null {
  const c = clause.trim();
  if (!c) return "ignore";
  if (isReadRequest(c) && !/^为什么/.test(c)) return { op: "inspect", query: c.slice(0, 2000) };
  // 只是限定语，不产生动作
  if (/^(其他|别的|其余|另外的)(的)?(都)?(不动|不变|不用动|不要动|保持|照旧)/.test(c)) return "ignore";

  // Owner corrections select admission, not a guessed duration or a new task.
  const classify = /^(?:把|将)?(.+?)(?:作为|当作|改为|改成|归为|设为)(学习任务|项目任务|日常待办|待办|待决策|决策事项|通知|活动|待确认)(?:安排|处理|记录|保存)?$/.exec(c);
  if (classify) {
    const labels: Record<string, "study" | "todo" | "decision" | "notice" | "event" | "unknown"> = { 学习任务: "study", 项目任务: "study", 日常待办: "todo", 待办: "todo", 待决策: "decision", 决策事项: "decision", 通知: "notice", 活动: "event", 待确认: "unknown" };
    return { op: "classify_task", ref: refOf(classify[1]!, referenceDate), taskKind: labels[classify[2]!]! };
  }
  const remindOnly = /^(?:把|将)?(.+?)(?:只|仅)(?:提醒|记待办|保留提醒)(?:[，,]?)(?:不要|不|别)(?:再)?(?:安排|排)(?:学习)?(?:时间)?$/.exec(c);
  if (remindOnly) return { op: "classify_task", ref: refOf(remindOnly[1]!, referenceDate), taskKind: "todo" };

  // 停止处理刚才那份材料（不是撤销已生效的变化）
  if (/(刚才|刚刚|上一份|上一条|那份|那条|上面)/.test(c) && /(别|不用|不要|停止|取消|先不)(再|用)?(处理|识别|解析|读|弄)/.test(c)) return { op: "cancel_intake" };

  if (hints.fixedEventTitles?.length) {
    const fixed = fixedEventIntent(c, hints.fixedEventTitles, referenceDate);
    if (fixed) return fixed;
  }

  if (/^(撤销|撤回)$/.test(c) || (/(撤销|撤回|取消|改回|恢复)/.test(c) && /(刚才|刚刚|上一|上次|那次|这次|那个|调整|修改|改动)/.test(c) && !/规则/.test(c))) return { op: "undo" };

  // 纠正实践分钟：“刚才那次其实40分钟”“其实那次只用了40分钟”
  const correct = new RegExp(`(?:其实|实际上?|实际).{0,6}?(?:只)?(?:用了|学了|做了|花了|是)?\\s*(${DURATION})`).exec(c);
  if (correct && /(刚才|刚刚|上次|那次|昨天|其实|实际)/.test(c)) {
    const minutes = durationOf(correct[1]!);
    if (minutes) return { op: "correct_practice", minutes };
  }

  // 截止修改：“报告改到周五交”
  const due = new RegExp(`^(?:把|将)?(.+?)(?:的)?(?:截止|ddl)?(?:改到|改成|推迟到|延到|延期到|提前到)(.+?)(?:交|截止|提交)`, "i").exec(c);
  if (due) {
    const date = dateFromText(due[2]!, referenceDate);
    if (date) return { op: "set_due", ref: refOf(due[1]!, referenceDate), dueLocalDate: date, dueLocalTime: timeFromText(due[2]!) };
  }

  // 课程：停课 / 调课（主语里有“课”或明确的停课说法）
  const cancelCourse = new RegExp(`^(${DATE_WORD})(?:的)?(.*?)(?:停课|不上了|不上课|取消了?)$`).exec(c);
  if (cancelCourse && (/课/.test(c) || /停课/.test(c))) {
    const date = dateFromText(cancelCourse[1]!, referenceDate);
    const name = cancelCourse[2]!.replace(/的?课程?$|^的/g, "").trim();
    if (date) return { op: "course_cancel", courseName: name || null, date };
  }
  const moveCourse = new RegExp(`^(?:把|将)?(${DATE_WORD})(?:的)?(.*?课.*?|.*?)(?:改|调|挪|移|换)到(.+)$`).exec(c);
  if (moveCourse && /课/.test(moveCourse[2]!)) {
    const sourceDate = dateFromText(moveCourse[1]!, referenceDate);
    const targetDate = dateFromText(moveCourse[3]!, referenceDate);
    const name = moveCourse[2]!.replace(/的?课程?$|^的/g, "").trim();
    if (sourceDate && targetDate) return { op: "course_move", courseName: name || null, sourceDate, targetDate, startLocalTime: timeFromText(moveCourse[3]!) };
  }

  // 挪学习安排：“把今晚微积分挪到明天下午”“刚才那个挪到周六”
  const move = /^(?:把|将)?(.+?)(?:挪|移|改|调|换|推|放)到(.+)$/.exec(c);
  if (move && !/课$|的课|上课|交|截止/.test(move[1]!)) {
    const target = move[2]!;
    const targetDate = dateFromText(target, referenceDate);
    const p = partOf(target);
    const time = timeFromText(target);
    if (targetDate || p !== "any" || time) {
      const t = time && p === "any" && !/上午|早上|中午/.test(target) && Number(time.slice(0, 2)) < 8 ? `${String(Number(time.slice(0, 2)) + 12).padStart(2, "0")}${time.slice(2)}` : time;
      return { op: "move_session", ref: refOf(move[1]!, referenceDate), targetDate, part: p, startLocalTime: t };
    }
  }

  // 只改这一段的长度：“这次复习只留半小时”
  const shorten = new RegExp(`^(.+?)只(?:留|做|学|安排|排)\\s*(${DURATION})`).exec(c);
  if (shorten) {
    const minutes = durationOf(shorten[2]!);
    if (minutes) return { op: "shorten_session", ref: refOf(shorten[1]!, referenceDate), durationMinutes: minutes };
  }

  // 定期关注某个方向 / 不再关注
  const topic = /^(?:以后)?每(?:周|星期|礼拜)\s*([一二三四五六日天])(.{0,10}?)(?:帮我|给我|替我)?(?:找找|找|搜|看看|留意|关注)(?:一下|一次)?(.{2,40}?)(?:方向|方面|相关)?(?:的)?(?:项目|机会|比赛|资料|信息|动态)?$/.exec(c);
  if (topic && !/^(项目|机会|比赛|资料|信息|动态|新的?)$/.test(topic[3]!.trim())) {
    const time = clock(topic[2]!);
    return { op: "explore_topic", title: topic[3]!.trim(), weekday: WEEKDAY_INDEX[topic[1]!]!, stop: false, ...(time ? { localTime: time } : {}) };
  }
  const untopic = /^(?:以后)?(?:别|不用|不要|停止|取消)(?:再)?(?:定期|每周)?(?:帮我|给我)?(?:找|关注|留意|搜)(.{2,40}?)(?:方向|方面|相关)?(?:的)?(?:项目|机会|比赛|资料|信息|动态)?了?$/.exec(c);
  if (untopic && !/^(项目|机会|新的?)$/.test(untopic[1]!.trim()) && !/(主动|定期|自动)$/.test(untopic[1]!)) return { op: "explore_topic", title: untopic[1]!.trim(), stop: true };

  // 找候选项目
  if (/(帮我|给我|替我)(找|挑|选|推荐|看看有没有).{0,40}(项目|方向|课题|练手)/.test(c)) return { op: "explore", query: c.slice(0, 500) };
  // 资料的归属与事实类型
  const toProject = /(?:这篇|这份|这个|刚才的?|那份|上面的?)?(?:文章|资料|链接|笔记|材料)?(?:归到|放到|归入|关联到)(.+?)(?:项目)?(?:里|下)?$/.exec(c);
  if (toProject && /(文章|资料|链接|笔记|材料|这篇|这份|刚才)/.test(c)) return { op: "resource_link", projectText: nameOf(toProject[1]!) || toProject[1]! };
  if (/不是我(自己)?(完成|做|写)的|是(老师|导师|助教|课程|学院|别人|同学)(的|给的|布置的)?(要求|作业要求|规定|布置)/.test(c)) return { op: "resource_role", role: "requirement" };
  if (/(这|那|刚才).{0,6}是我(自己)?(完成|做|写)的(成果)?/.test(c)) return { op: "resource_role", role: "achievement" };
  // 试做 / 正式投入
  const trial = /^(.*?)(?:先)?(?:试做|试一试|试试|试一下|试着做)(.*)$/.exec(c) ?? /^(?:那|就|我)?(?:先)?试()((?:这个|那个|它|第\s*[一二三四五六七八九十\d]+\s*个).*)$/.exec(c);
  if (trial) {
    const weeks = new RegExp(`(${NUM})\\s*(?:个)?\\s*(?:周|星期|礼拜)`).exec(c);
    const n = weeks ? parseNumber(weeks[1]!) : 2;
    const subject = trial[1]!.replace(/^(那|就|先|我想|我要|想)+/, "") || trial[2]!.replace(new RegExp(`(${NUM})\\s*(?:个)?\\s*(?:周|星期|礼拜)`), "");
    const ord = /第\s*([一二三四五六七八九十\d]+)\s*个/.exec(c);
    return { op: "trial", ref: ord || !nameOf(subject) || /^(这个|那个|它|这)$/.test(subject.trim()) ? { kind: "recent" } : refOf(subject, referenceDate), ordinal: ord ? parseNumber(ord[1]!) : null, weeks: Number.isInteger(n) && n >= 1 && n <= 12 ? n : 2, commit: false };
  }
  const commit = /^(.+?)(?:转为|改为|改成|变成)?正式(?:投入|做|开始)/.exec(c);
  if (commit && isShortName(commit[1]!)) return { op: "project_state", ref: refOf(commit[1]!, referenceDate), status: null, commit: true };
  const projectEnd = /^(.+?)项目(?:先)?(暂停|停一下|放一放|结束|做完了|恢复|继续)/.exec(c);
  if (projectEnd && isShortName(projectEnd[1]!)) {
    const w = projectEnd[2]!;
    return { op: "project_state", ref: refOf(projectEnd[1]!, referenceDate), status: /暂停|停一下|放一放/.test(w) ? "paused" : /结束|做完/.test(w) ? "completed" : "active", commit: false };
  }
  // 目标：这学期先……/主要目标是……
  const goal = /^(这学期|本学期|这个学期|今年|长期)(?:的)?(?:主要|重点)?(?:目标|方向)?(?:是|先|主要是|重点是)?(.+)$/.exec(c);
  if (goal && /(先|主要|重点|目标|方向)/.test(c) && !/(交|截止|预计|小时|分钟|安排|排)/.test(c) && nameOf(goal[2]!).length >= 2 && nameOf(goal[2]!).length <= 20) {
    return { op: "goal", title: goal[2]!.replace(/^(先|主要|重点)/, "").trim(), horizon: /长期/.test(goal[1]!) ? "long_term" : "semester", primary: true };
  }

  // 通知筛选规则：某类人群专属的通知不用给我 / 撤回
  if (/通知/.test(c)) {
    const audienceWord = /(研究生|硕士|博士|本科生?)/.exec(c)?.[1];
    if (audienceWord && /(不用|不要|别|不必|不需要)(再)?(给我)?(推|发|看|显示|提醒|通知)?/.test(c) && /(专属|的|类)?通知/.test(c)) {
      return { op: "notice_filter", field: "education_level", value: normalizeProfileValue("education_level", audienceWord), remove: false };
    }
    if (audienceWord && /(还是|恢复|重新)(给我)?(看|推|显示)/.test(c)) return { op: "notice_filter", field: "education_level", value: normalizeProfileValue("education_level", audienceWord), remove: true };
  }
  if (/(撤销|撤回|取消|去掉|删掉).{0,6}(筛选|过滤)(规则)?/.test(c)) return { op: "notice_filter", field: "education_level", value: "*", remove: true };
  // 第一人称的身份陈述：“我是AI专业大一”“我在江安校区”
  if (/^我(是|在|读|学|就读|现在)/.test(c) && !/(想|打算|准备|要去|希望)/.test(c)) {
    const facts = profileFactsFromText(c);
    if (facts.length) return { op: "profile", facts };
  }
  // 询问状态：为什么没提醒 / 为什么这样安排
  if (/为什么|为啥|怎么/.test(c)) {
    if (/(没|不)(有)?(提醒|收到|发)/.test(c)) return { op: "explain", topic: "reminders" };
    if (/(这样|这么)(安排|排)|排在/.test(c)) return { op: "explain", topic: "plan" };
  }
  if (isReadRequest(c)) return { op: "inspect", query: c.slice(0, 2000) };
  if (/(打包|导出|备份)(我的)?.{0,8}(成果|数据|记录|全部)/.test(c)) return { op: "export" };

  // 主动程度与模型预算
  const calls = new RegExp(`每天最多(?:用|调用)?\\s*(\\d+)\\s*次(?:模型|AI|大模型)|(?:模型|AI)(?:调用)?每天最多\\s*(\\d+)\\s*次`).exec(c);
  if (calls) return { op: "agent_policy", dailyModelCalls: Number(calls[1] ?? calls[2]) };
  // 定期复盘的时间 / 停掉定期复盘（只动复盘，不连带停探索）
  if (/复盘/.test(c)) {
    if (/(别|不要|不用|停止|暂停|取消)(再)?(主动|定期|自动|每周)(帮我|给我)?(做)?复盘/.test(c)) return { op: "agent_policy", weeklyReview: null };
    const wd = /每(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(c);
    if (wd) return { op: "agent_policy", weeklyReview: { weekday: WEEKDAY_INDEX[wd[1]!]!, localTime: clock(c) ?? "20:00" } };
    if (/^(帮我|给我|替我)?(做个?|来个?)?(复盘|回顾|总结)(一下)?(上周|这周|本周|上个星期|这个星期)|(上周|这周|本周|上个星期|这个星期).{0,6}复盘|^(帮我|给我|替我)(做个?|来个?)?复盘/.test(c)) {
      return { op: "review", week: /(这周|本周|这个星期)/.test(c) ? "this" : "last" };
    }
  }
  if (/(别|不要|不用|停止|暂停)(再)?(主动|定期|自动)(帮我)?(找|探索|推荐|复盘)/.test(c) || /没(有)?新(消息|东西|进展)就别(问|找|推)/.test(c)) return { op: "agent_policy", scheduledEnabled: false };
  if (/(恢复|继续|重新开始)(定期|主动)(探索|找项目|复盘)|每周(帮我)?(找|看)一次项目/.test(c)) return { op: "agent_policy", scheduledEnabled: true };

  // 摘要邮件
  if (/(摘要|日报|每周回顾|周报)/.test(c)) {
    // 现在就要一份（不是改定期策略）
    if (/(现在|马上|立刻|立即|这就)/.test(c) && /(发|给|来)/.test(c) && !/(不发|别发|不要|不用)/.test(c)) return { op: "digest_now", kind: /(周报|每周|本周|这周)/.test(c) ? "weekly" : "daily" };
    if (/(不发|别发|不要|不用|关掉|关闭|取消|停掉|停止)/.test(c)) return /(每周回顾|周报)/.test(c) ? { op: "digest", weeklyEnabled: false } : { op: "digest", dailyEnabled: false };
    const raw = timeFromText(c);
    if (raw) {
      const h = Number(raw.slice(0, 2));
      const time = /晚|傍晚|下午/.test(c) && h < 12 ? `${String(h + 12).padStart(2, "0")}${raw.slice(2)}` : raw;
      const wd = /每周\s*([一二三四五六日天])/.exec(c);
      if (wd || /(每周回顾|周报)/.test(c)) return { op: "digest", weeklyEnabled: true, weeklyTime: time, ...(wd ? { weeklyWeekday: WEEKDAY_INDEX[wd[1]!]! } : {}) };
      return { op: "digest", dailyEnabled: true, dailyTime: time, weekdaysOnly: /工作日|周一到周五/.test(c) };
    }
  }
  // 提醒：某个任务提前多久、全局开关、安静时段
  const lead = new RegExp(`^(.+?)提前\\s*((?:${NUM})\\s*(?:个)?\\s*(?:天|小时|钟头|分钟))(?:提醒|通知|叫我)`).exec(c);
  if (lead && isShortName(lead[1]!)) {
    const days = new RegExp(`(${NUM})\\s*天`).exec(lead[2]!);
    const minutes = days ? Math.round((days[1] === "半" ? 0.5 : parseNumber(days[1]!)) * 1440) : durationOf(lead[2]!);
    if (minutes !== null && !Number.isNaN(minutes)) return { op: "task_reminder", ref: refOf(lead[1]!, referenceDate), leadMinutes: minutes };
  }
  if (/提醒|邮件|打扰/.test(c)) {
    const quiet = /(.+?点\s*(?:半)?)\s*(?:到|至|-)\s*(.+?点\s*(?:半)?)\s*(?:之间)?(?:别|不要|不用)(?:发|打扰|提醒)/.exec(c);
    if (quiet) {
      const start = eveningTime(quiet[1]!);
      const end = timeFromText(quiet[2]!);
      if (start && end) return { op: "reminders", quietStart: start, quietEnd: end };
    }
    if (/(别|不要|不用|不必)(再)?(给我)?(发)?提醒|关(掉|闭)提醒|取消提醒/.test(c)) return { op: "reminders", enabled: false };
    if (/只提醒临近截止|临近截止(再|才)?提醒|截止前提醒我|(开启|打开|恢复)提醒/.test(c)) return { op: "reminders", enabled: true };
  }

  // 校历/节假日自动核对的开关与频率
  // 必须明说“自动/定期/每隔多久”：单说“校历更新了”是陈述，不是要开启自动核对
  if (/(节假日|校历|调课|调休|假期安排)/.test(c) && /(获取|更新|同步|核对|检查|查)/.test(c) && /(自动|定期|每周|每天|每两周|每\d+\s*天)/.test(c)) {
    const off = /(别|不要|不用|停止|关闭|取消).{0,6}(自动|再)/.test(c);
    const days = /每\s*(\d+)\s*天/.exec(c);
    const intervalDays = days ? Number(days[1]) : /每两周|每2周/.test(c) ? 14 : /每周/.test(c) ? 7 : /每天/.test(c) ? 1 : null;
    return { op: "calendar_sync", enabled: !off, intervalDays };
  }

  // 假期策略（在“某天不学”之前判断，避免把“假期不安排”当成具体日期）
  if (/(假期|节假日|放假期间|放假时)/.test(c)) {
    if (/(不安排|不学|别排|别安排|不要安排|休息)/.test(c)) return { op: "holiday_policy", mode: "none" };
    if (/(少排|少学|少安排|轻松点|少一点)/.test(c)) return { op: "holiday_policy", mode: "reduced" };
    if (/(照常|正常|按周末|和周末一样|照样)/.test(c)) return { op: "holiday_policy", mode: "weekend_template" };
  }

  // 上限：按星期 / 工作日周末 / 某天 / 每天
  const cap = new RegExp(`最多(?:再)?(?:学|排|安排|学习)?\\s*(${DURATION})`).exec(c);
  if (cap) {
    const minutes = durationOf(cap[1]!);
    if (minutes !== null) {
      const persistent = /(以后|今后|往后|每个?周|每逢|都|一直|长期)/.test(c);
      const group = /(工作日|平时|上课日|周一到周五)/.test(c) ? "workday" : /周末|双休/.test(c) ? "weekend" : null;
      if (group) return { op: "group_limit", group, limitMinutes: minutes };
      const wd = /(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(c);
      if (wd && !/(本|这|下)\s*(?:周|星期|礼拜)/.test(c)) return { op: "weekday_limit", weekday: WEEKDAY_INDEX[wd[1]!]!, limitMinutes: minutes, persistent };
      const date = dateFromText(c, referenceDate);
      if (date) return { op: "date_limit", date, limitMinutes: minutes };
      if (/每天|一天|每日/.test(c)) return { op: "daily_limit", limitMinutes: minutes };
    }
  }

  // 时段边界：“晚上十点后不排”“九点前别排”
  const after = /(.+?点\s*(?:半|一刻|\d{1,2}\s*分?)?)\s*(?:以后|之后|后)\s*(?:就)?(?:不排|不学|不安排|别排|别安排|不要安排|不再安排)/.exec(c);
  if (after) {
    const time = eveningTime(after[1]!);
    if (time) return { op: "window_end", time };
  }
  const beforeT = /(.+?点\s*(?:半|一刻|\d{1,2}\s*分?)?)\s*(?:以前|之前|前)\s*(?:不排|不学|不安排|别排|别安排|不要安排)/.exec(c);
  if (beforeT) {
    const time = timeFromText(beforeT[1]!);
    if (time) return { op: "window_start", time };
  }

  // 某天/某晚不学、某段日期不安排
  if (/(不学了?|不学习了?|不想学|不安排|别安排|别排|不要安排|休息一下|歇一歇|歇了)/.test(c) && !/(以后|点后|点之后)/.test(c)) {
    const range = new RegExp(`(${DATE_WORD})\\s*(?:到|至|-|—|~)\\s*(${DATE_WORD}|\\d{1,2}\\s*[日号])`).exec(c);
    if (range) {
      const from = dateFromText(range[1]!, referenceDate);
      const toRaw = /^\d{1,2}\s*[日号]$/.test(range[2]!) && from ? `${Number(from.slice(5, 7))}月${range[2]}` : range[2]!;
      const to = dateFromText(toRaw, referenceDate);
      if (from && to && to >= from) return { op: "no_study", dateFrom: from, dateTo: to, fromTime: null, label: /回家/.test(c) ? "回家" : /旅行|出去玩|旅游/.test(c) ? "出行" : "不安排学习" };
    }
    const date = dateFromText(c, referenceDate);
    if (date) {
      const tonight = /今晚|明晚|晚上/.test(c);
      const today = date === referenceDate;
      const current = hhmm(now, tz);
      const fromTime = tonight ? (today && current > "18:00" ? current : "18:00") : today ? current : null;
      return { op: "no_study", dateFrom: date, dateTo: date, fromTime, label: tonight ? `${today ? "今晚" : "那天晚上"}不学` : today ? "今天不学了" : "这天不学" };
    }
  }

  // 重新安排的授权与撤回
  if (/(你看着|你来|你帮我|帮我|你)(重新|再)?(安排|排一下|排排|调整|规划)/.test(c) && /(今天|明天|这周|本周|今晚)/.test(c) && !/(以后|点)/.test(c)) {
    const week = /(这周|本周)/.test(c);
    const date = week ? referenceDate : (dateFromText(c, referenceDate) ?? referenceDate);
    const to = week ? addDays(referenceDate, 7 - (((new Date(`${referenceDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1)) : date;
    return { op: "replan", dateFrom: date, dateTo: to };
  }
  if (/(别|不要|不用|不许)(再)?(自动)?(帮我)?(调整|动|改|重排|重新安排)/.test(c) && /安排|计划|学习块/.test(c)) return { op: "revoke_replan" };
  if (/^(那)?(就)?按(你|您)?(的)?(推荐|建议|说的)(的)?(来|安排|办|排)?(吧|就行)?$|^你(帮我|来)?(决定|定|安排)(吧|就行|就好)?$|^(那)?就这样(吧)?$/.test(c)) return { op: "confirm_policy" };

  // 集中时段偏好
  const prefer = /(晚上|晚间|上午|早上|下午|周末).{0,8}(更适合|比较适合|最适合|集中学|效率高|效率更高|学得进|状态好)/.exec(c) ?? /(?:我)?(?:一般|习惯|喜欢)(?:在)?(晚上|晚间|上午|早上|下午|周末)(?:集中)?(?:学|学习|做)/.exec(c);
  if (prefer) {
    const word = prefer[1]!;
    return { op: "prefer_window", part: /周末/.test(word) ? "weekend" : /上午|早上/.test(word) ? "morning" : /下午/.test(word) ? "afternoon" : "evening" };
  }

  // 暂停 / 恢复
  const pause = /^(?:把|将)?(.+?)(?:先)?(?:缓|缓一缓|放一放|暂停|停一下|搁置|放下|往后放)(.*)$/.exec(c);
  if (pause && isShortName(pause[1]!) && !/课$/.test(nameOf(pause[1]!))) return { op: "pause_task", ref: refOf(pause[1]!, referenceDate), until: untilOf(pause[2]!, referenceDate) };
  const resume = /^(?:恢复|继续做?|重新开始)(.+)$/.exec(c);
  if (resume && isShortName(resume[1]!)) return { op: "resume_task", ref: refOf(resume[1]!, referenceDate) };

  // 剩余需求：“报告还差一个小时”
  const remaining = new RegExp(`^(.+?)(?:还差|还剩|还需要|还要|还得)(?:大概|大约|差不多)?\\s*(${DURATION})`).exec(c);
  if (remaining) {
    const minutes = durationOf(remaining[2]!);
    if (minutes !== null && isShortName(remaining[1]!)) return { op: "remaining", ref: refOf(remaining[1]!, referenceDate), minutes };
  }

  // 优先级：“实验优先”“以后先保证数学”
  const first = /^(?:以后|今后)?(?:先保证|优先做|先做|优先)(.+)$/.exec(c) ?? /^(.+?)(?:优先|先做|排前面|更重要)$/.exec(c);
  if (first && isShortName(first[1]!)) return { op: "prioritize", ref: refOf(first[1]!, referenceDate) };

  if (isCompletionReport(c)) {
    const name = c.replace(/做完了?|写完了?|搞定了?|完成了?|已经|已|提交了?|交了|弄完了?|结束了/g, "").replace(new RegExp(`(?:花了|用了)?\\s*${DURATION}`, "g"), "");
    if (nameOf(name).length >= 2) return { op: "complete", ref: refOf(name, referenceDate), actualMinutes: null };
  }
  return null;
}

/** 把主人原话按分句解析成意图；认不出的分句原样留在 rest 里交给后续分类 */
export function parseInstruction(text: string, referenceDate: string, now: Date, tz: string, hints: ParseHints = {}): ParsedInstruction {
  const intents: ParsedInstruction["intents"] = [];
  const rest: string[] = [];
  for (const line of text.split(/\n+/)) {
    // 通知/公告体的正文是资料，不是主人的指令：整行留给分类
    if (/^[^，。]{0,30}(通知|公告|公示|启事)[^，。]{0,10}[：:]/.test(line.trim()) || /^关于.{2,40}的(通知|公告)/.test(line.trim())) {
      rest.push(line.trim());
      continue;
    }
    // “这条只提醒，不安排学习时间” is one admission correction, not a global no-study policy.
    const joinedReminder = line.replace(/((?:只|仅)提醒|只记待办|保留提醒)[，,]\s*((?:不要|不|别)(?:再)?(?:安排|排)(?:学习)?(?:时间)?)/g, "$1$2");
    const clauses = joinedReminder.split(/[，,；;。！!]+/).map((c) => c.trim()).filter(Boolean);
    const kept: string[] = [];
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]!;
      let parsed = parseClause(clause, referenceDate, now, tz, hints);
      let source = clause;
      // 一句话被逗号拆成两半（“以后周三少排点，最多一小时”）：和下一个分句合起来再认一次
      const next = clauses[i + 1];
      if (!parsed && next && !parseClause(next, referenceDate, now, tz, hints)) {
        const joined = parseClause(clause + next, referenceDate, now, tz, hints);
        if (joined && joined !== "ignore") {
          parsed = joined;
          source = `${clause}，${next}`;
          i++;
        }
      }
      if (parsed === "ignore") continue;
      if (parsed) {
        // “做完了，花了40分钟”：紧跟的时长属于这次完成
        if (parsed.op === "complete") {
          const spentHere = new RegExp(`(?:花了|用了)\\s*(${DURATION})`).exec(source);
          const follow = clauses[i + 1];
          const spentNext = follow ? new RegExp(`^(?:一共|总共)?(?:花了|用了)\\s*(${DURATION})$`).exec(follow) : null;
          const minutes = durationOf((spentHere ?? spentNext)?.[1] ?? "");
          if (minutes) parsed.actualMinutes = minutes;
          if (spentNext) {
            source = `${source}，${follow}`;
            i++;
          }
        }
        intents.push({ intent: parsed, clause: source });
      } else kept.push(clause);
    }
    if (kept.length) rest.push(kept.join("，"));
  }
  return { intents, rest: rest.join("\n") };
}
