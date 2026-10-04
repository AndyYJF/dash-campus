import { z } from "zod";
import { addDays } from "./time";
import { dateFromText, estimateFromText, isCompletionReport, parseNumber, timeFromText } from "./task-text";

/**
 * 主人指令的结构化意图（REPAIR-PLAN §5.1.1，AGENT-INTERFACE-CONTRACT §5.1）。
 * 这里只把“说了什么”变成有类型的意图：对象仍是文字引用，最终绑定哪个 ID 由服务端核对；
 * 模型输出的意图用同一个 schema 校验，和确定性解析走同一条绑定/执行通路。
 * 解析不了就不认，交给后面的分类，不猜。
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const part = z.enum(["morning", "afternoon", "evening", "any"]);

/** 对象的文字引用：recent = “刚才那个”；named = 名称 + 可选的日期/时段限定 */
export const refSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("recent") }),
  z.object({ kind: z.literal("named"), text: z.string().min(1).max(100), date: dateStr.nullable().default(null), part: part.default("any") }),
]);
export type Ref = z.infer<typeof refSchema>;

export const intentSchema = z.discriminatedUnion("op", [
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
  z.object({ op: z.literal("prioritize"), ref: refSchema }),
  z.object({ op: z.literal("set_due"), ref: refSchema, dueLocalDate: dateStr, dueLocalTime: timeStr.nullable().default(null) }),
  z.object({ op: z.literal("remaining"), ref: refSchema, minutes: z.number().int().min(0).max(100_000) }),
  z.object({ op: z.literal("complete"), ref: refSchema, actualMinutes: z.number().int().min(1).max(1440).nullable().default(null) }),
  z.object({ op: z.literal("correct_practice"), minutes: z.number().int().min(1).max(1440) }),
  z.object({ op: z.literal("course_cancel"), courseName: z.string().max(100).nullable().default(null), date: dateStr }),
  z.object({ op: z.literal("course_move"), courseName: z.string().max(100).nullable().default(null), sourceDate: dateStr, targetDate: dateStr, startLocalTime: timeStr.nullable().default(null) }),
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

function refOf(subject: string, referenceDate: string): Ref {
  if (/刚才|刚刚|上一个|上面那个|那个$|^那个|^它$|^这个$/.test(subject) && nameOf(subject.replace(/刚才|刚刚|上一个|上面/g, "")).length < 2) return { kind: "recent" };
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

function parseClause(clause: string, referenceDate: string, now: Date, tz: string): Intent | "ignore" | null {
  const c = clause.trim();
  if (!c) return "ignore";
  // 只是限定语，不产生动作
  if (/^(其他|别的|其余|另外的)(的)?(都)?(不动|不变|不用动|不要动|保持|照旧)/.test(c)) return "ignore";

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
  if (pause && nameOf(pause[1]!).length >= 2) return { op: "pause_task", ref: refOf(pause[1]!, referenceDate), until: untilOf(pause[2]!, referenceDate) };
  const resume = /^(?:恢复|继续做?|重新开始)(.+)$/.exec(c);
  if (resume && nameOf(resume[1]!).length >= 2) return { op: "resume_task", ref: refOf(resume[1]!, referenceDate) };

  // 剩余需求：“报告还差一个小时”
  const remaining = new RegExp(`^(.+?)(?:还差|还剩|还需要|还要|还得)(?:大概|大约|差不多)?\\s*(${DURATION})`).exec(c);
  if (remaining) {
    const minutes = durationOf(remaining[2]!);
    if (minutes !== null && nameOf(remaining[1]!).length >= 2) return { op: "remaining", ref: refOf(remaining[1]!, referenceDate), minutes };
  }

  // 优先级：“实验优先”“以后先保证数学”
  const first = /^(?:以后|今后)?(?:先保证|优先做|先做|优先)(.+)$/.exec(c) ?? /^(.+?)(?:优先|先做|排前面|更重要)$/.exec(c);
  if (first && nameOf(first[1]!).length >= 2) return { op: "prioritize", ref: refOf(first[1]!, referenceDate) };

  if (isCompletionReport(c)) {
    const name = c.replace(/做完了?|写完了?|搞定了?|完成了?|已经|已|提交了?|交了|弄完了?|结束了/g, "").replace(new RegExp(`(?:花了|用了)?\\s*${DURATION}`, "g"), "");
    if (nameOf(name).length >= 2) return { op: "complete", ref: refOf(name, referenceDate), actualMinutes: null };
  }
  return null;
}

/** 把主人原话按分句解析成意图；认不出的分句原样留在 rest 里交给后续分类 */
export function parseInstruction(text: string, referenceDate: string, now: Date, tz: string): ParsedInstruction {
  const intents: ParsedInstruction["intents"] = [];
  const rest: string[] = [];
  for (const line of text.split(/\n+/)) {
    const clauses = line.split(/[，,；;。！!]+/).map((c) => c.trim()).filter(Boolean);
    const kept: string[] = [];
    for (let i = 0; i < clauses.length; i++) {
      const clause = clauses[i]!;
      let parsed = parseClause(clause, referenceDate, now, tz);
      let source = clause;
      // 一句话被逗号拆成两半（“以后周三少排点，最多一小时”）：和下一个分句合起来再认一次
      const next = clauses[i + 1];
      if (!parsed && next && !parseClause(next, referenceDate, now, tz)) {
        const joined = parseClause(clause + next, referenceDate, now, tz);
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
