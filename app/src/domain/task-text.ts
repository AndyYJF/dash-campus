import { addDays, mondayOf } from "./time";

/**
 * 用户原文的确定性解析（REPAIR-PLAN §4.3/§5.2）：估时、截止日期与钟点、完成表达、对象匹配。
 * 纯函数；相对日期一律以投递参照日为基准，重试不改变结果。解析不了就返回 null，不猜。
 */

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const NUM = String.raw`\d+(?:\.\d+)?|[一二两三四五六七八九十]+`;

/** 阿拉伯数字或 99 以内的中文数字 */
export function parseNumber(raw: string): number {
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  const m = /^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/.exec(raw);
  if (!m || (!m[1] && !m[2] && !m[3])) return NaN;
  if (!m[2]) return m[3] ? NaN : CN_DIGIT[m[1]!]!;
  return (m[1] ? CN_DIGIT[m[1]]! : 1) * 10 + (m[3] ? CN_DIGIT[m[3]]! : 0);
}

/** 「2小时 / 两小时 / 一个半小时 / 1小时20分钟 / 半小时 / 四十分钟 / 一刻钟」→ 分钟 */
export function estimateFromText(text: string): number | null {
  const half = new RegExp(`(${NUM})\\s*个半\\s*(?:小时|钟头)|(${NUM})\\s*(?:个)?\\s*(?:小时|钟头)半`).exec(text);
  if (half) {
    const n = parseNumber((half[1] ?? half[2])!);
    if (!Number.isNaN(n)) return Math.round(n * 60) + 30;
  }
  const hours = new RegExp(`(${NUM})\\s*(?:个)?\\s*(?:小时|钟头|h(?![a-zA-Z]))(?:\\s*(${NUM})\\s*分钟?)?`, "i").exec(text);
  if (hours) {
    const n = parseNumber(hours[1]!);
    const extra = hours[2] ? parseNumber(hours[2]) : 0;
    if (!Number.isNaN(n) && !Number.isNaN(extra)) return Math.round(n * 60 + extra);
  }
  if (/半\s*(?:个)?\s*(?:小时|钟头)/.test(text)) return 30;
  if (/一刻钟/.test(text)) return 15;
  const minutes = new RegExp(`(${NUM})\\s*分钟`).exec(text);
  if (minutes) {
    const n = parseNumber(minutes[1]!);
    if (!Number.isNaN(n)) return Math.round(n);
  }
  return null;
}

export type ParsedDue = { localDate: string; localTime: string | null };

const WEEKDAY_INDEX: Record<string, number> = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 };

function validDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

export function dateFromText(text: string, referenceDate: string): string | null {
  const full = /(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})/.exec(text);
  if (full) return validDate(Number(full[1]), Number(full[2]), Number(full[3]));
  const md = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?/.exec(text);
  if (md) {
    const year = Number(referenceDate.slice(0, 4));
    const thisYear = validDate(year, Number(md[1]), Number(md[2]));
    // 没写年份：已经过去的月日指下一年
    return thisYear && thisYear < referenceDate ? validDate(year + 1, Number(md[1]), Number(md[2])) : thisYear;
  }
  if (/大后天/.test(text)) return addDays(referenceDate, 3);
  if (/后天/.test(text)) return addDays(referenceDate, 2);
  if (/明天|明日|明早|明晚/.test(text)) return addDays(referenceDate, 1);
  if (/今天|今日|今晚|今早/.test(text)) return referenceDate;
  const week = /(下下|下|本|这)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(text);
  if (week) {
    const monday = mondayOf(referenceDate);
    const offset = week[1] === "下下" ? 14 : week[1] === "下" ? 7 : 0;
    const date = addDays(monday, offset + WEEKDAY_INDEX[week[2]!]!);
    // 只说“周五”且本周五已过：指下一个周五
    return !week[1] && date < referenceDate ? addDays(date, 7) : date;
  }
  return null;
}

export function timeFromText(text: string): string | null {
  // 先去掉日期，避免把 10/5 之类当钟点
  const clock = /(?<![\d-])(\d{1,2})\s*[:：]\s*(\d{2})(?!\d)/.exec(text);
  if (clock && Number(clock[1]) < 24 && Number(clock[2]) < 60) return `${clock[1]!.padStart(2, "0")}:${clock[2]}`;
  const point = new RegExp(`(上午|早上|中午|下午|晚上|今晚|明晚|傍晚)?\\s*(${NUM})\\s*点\\s*(半|一刻|(${NUM})\\s*分?)?`).exec(text);
  if (point) {
    let h = parseNumber(point[2]!);
    const m = point[3] === "半" ? 30 : point[3] === "一刻" ? 15 : point[4] ? parseNumber(point[4]) : 0;
    if (Number.isInteger(h) && h <= 24 && Number.isInteger(m) && m < 60) {
      if (/下午|晚上|今晚|明晚|傍晚/.test(point[1] ?? "") && h < 12) h += 12;
      if (h === 24) h = 0;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    }
  }
  if (/(上午|中午)\s*(之)?前/.test(text)) return "12:00"; // “上午前”是有时刻含义的截止，不能当成无截止
  return null;
}

/** 截止：绝对日期、月日、今天/明天/后天、本周几/下周几 + 可选钟点；只有钟点时指参照日当天 */
export function dueFromText(text: string, referenceDate: string): ParsedDue | null {
  const localDate = dateFromText(text, referenceDate);
  const localTime = timeFromText(text);
  if (!localDate) return localTime && /前|截止|之前|ddl|deadline/i.test(text) ? { localDate: referenceDate, localTime } : null;
  return { localDate, localTime };
}

/** 明确的完成表达（不含“快做完”“还没做完”这类未完成说法） */
export function isCompletionReport(text: string): boolean {
  if (/没|未|快|差不多|还要|还差|打算|准备|想|要(?!了)/.test(text.replace(/要交|要求/g, ""))) return false;
  return /做完了?|写完了?|搞定了?|完成了|已完成|已经完成|交了|已交|提交了|弄完了?|结束了/.test(text);
}

const NOISE = /\d+(?:\.\d+)?|分钟|小时|钟头|预计|大概|花了|学了|做完了?|写完了?|搞定了?|完成了?|已经|已|提交了?|交了|弄完了?|结束了|刚才|刚刚|今天|那个|这个|我|把|的|了|[\s，。,.!！、:：]/g;

function longestCommon(a: string, b: string): number {
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      best = Math.max(best, prev[j]!);
      diag = tmp;
    }
  }
  return best;
}

export type TaskRef = { id: string; title: string };
export type TaskMatch = { kind: "one"; task: TaskRef } | { kind: "ambiguous"; candidates: TaskRef[] } | { kind: "none" };

/** 用名称找对象：按与原文的最长公共片段比较，唯一最优才绑定；并列则交给用户选，不猜 */
export function matchTask(text: string, tasks: TaskRef[]): TaskMatch {
  const needle = text.replace(NOISE, "");
  const scored = tasks.map((task) => ({ task, score: longestCommon(needle, task.title.replace(NOISE, "")) })).filter((s) => s.score >= 2);
  if (!scored.length) return { kind: "none" };
  const top = Math.max(...scored.map((s) => s.score));
  const best = scored.filter((s) => s.score === top);
  return best.length === 1 ? { kind: "one", task: best[0]!.task } : { kind: "ambiguous", candidates: best.map((s) => s.task) };
}

/** 用户在候选里选一个：序号（“1”“第二个”）或名称 */
export function pickCandidate(answer: string, candidates: TaskRef[]): TaskRef | null {
  const ordinal = /^\s*第?\s*(\d+|[一二两三四五六七八九十]+)\s*个?\s*$/.exec(answer);
  if (ordinal) {
    const n = parseNumber(ordinal[1]!);
    return Number.isInteger(n) && n >= 1 && n <= candidates.length ? candidates[n - 1]! : null;
  }
  const exact = candidates.filter((c) => c.title === answer.trim());
  if (exact.length === 1) return exact[0]!;
  const m = matchTask(answer, candidates);
  return m.kind === "one" ? m.task : null;
}
