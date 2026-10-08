import { dateFromText, estimateFromText, parseNumber } from "./task-text";

/**
 * “/安排 …” 的正文解析（纯函数）：一句话里可以有几件事，每件事可以自带时间。
 * - “下午3点到4点写微积分作业”：按话里的起止时间排，不是排在空档开头；
 * - “下午3点写微积分”：只有开始时间，时长在这里就定下来（话里说的 → 已有任务的估时 → 一小时），后一件接在它真正结束的地方；
 * - 没写时间：接在上一件之后，或排在点选的空档开头；
 * - 起止相同或倒着的时间不猜，原样指出。
 * 没写上午/下午的钟点按上下文判断：同一天里接在前一件之后，再看哪个落在点选的空档里，最后才按“8 点前算下午”。
 * 换了一天不沿用前一天的上午/下午。“多背一点单词”里的“一点”是数量，不是钟点。
 */

export type ArrangeSlot = { date: string; start: string; end: string };
export type ArrangePiece =
  | { ok: true; title: string; date: string; start: string; end: string; timed: "range" | "start" | "none" }
  | { ok: false; title: string; error: string };

const NUM = String.raw`\d{1,2}|[零一二两三四五六七八九十]{1,3}`;
const PART = String.raw`凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明晚`;
const TIME = String.raw`(${PART})?\s*(${NUM})\s*(?:[:：]\s*(\d{2})|点\s*(半|一刻|三刻|(?:${NUM})\s*分?)?)`;
const RANGE = new RegExp(`${TIME}\\s*(?:到|至|-|–|—|~|～)\\s*${TIME}`);
const DATE = String.raw`\d{4}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|大后天|后天|明天|明日|明早|今天|今日|今早|(?:下下|下|本|这)?\s*(?:周|星期|礼拜)\s*[一二三四五六日天]`;
/** 紧贴在钟点前面的日期（“周五下午3点”里的“周五”） */
const DATE_BEFORE_TIME = new RegExp(`(?:${DATE})\\s*的?\\s*$`);
/** 钟点前面只有这些词时，钟点算在句首（“然后明天三点写作业”） */
const LEAD = new RegExp(`^(?:[\\s、]|然后|接着|之后|再|还有|另外|以及|和|并且|我|想|要|帮我|请|麻烦|${DATE}|在|从|于)*$`);
const MAX_PIECES = 6;
const DAY = 24 * 60;

/** 话里说的时段。晚上和凌晨分开：晚上 12 点是这一天的最后一刻，凌晨 12 点是这一天的开头 */
type Part = "dawn" | "am" | "noon" | "pm" | "night";
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function clausesOf(body: string): string[] {
  return body
    .split(/[，,；;。\n]+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

function minuteOf(clock: string | undefined, dot: string | undefined): number {
  if (clock) return Number(clock);
  if (!dot) return 0;
  if (dot === "半") return 30;
  if (dot === "一刻") return 15;
  if (dot === "三刻") return 45;
  return parseNumber(dot.replace(/分/, "").trim());
}

function partOf(word: string | undefined): Part | null {
  if (!word) return null;
  if (word === "凌晨") return "dawn";
  if (word === "中午") return "noon";
  if (/下午|傍晚/.test(word)) return "pm";
  if (/晚/.test(word)) return "night";
  return "am";
}

/**
 * 钟点 → 当天分钟；1440 及以上表示已经到了第二天（晚上12点、晚上1点、24点）。
 * part 为空表示话里没说上午还是下午，由 pick 在两种读法里选
 */
function resolve(hour: number, minute: number, part: Part | null, pick: (am: number, pm: number) => number): number | null {
  if (!Number.isInteger(hour) || hour > 24 || !Number.isInteger(minute) || minute > 59) return null;
  if (hour === 24) return DAY + minute;
  if (hour >= 13) return hour * 60 + minute;
  if (part === "night") return (hour === 12 ? 24 : hour <= 4 ? hour + 24 : hour + 12) * 60 + minute; // 晚上12点 = 24:00
  if (part === "pm") return (hour === 12 ? 12 : hour + 12) * 60 + minute;
  if (part === "noon") return (hour <= 2 ? hour + 12 : hour) * 60 + minute; // 中午1点 = 13:00
  if (part === "dawn") return (hour === 12 ? 0 : hour) * 60 + minute;
  if (part === "am") return hour * 60 + minute; // 上午12点 = 12:00
  if (hour === 12) return 12 * 60 + minute;
  return pick(hour * 60 + minute, (hour + 12) * 60 + minute);
}

/**
 * 一句里的单个钟点。中文数字加“点”也可能是数量（“多背一点单词”“复习三点内容”）：
 * 没带上午/下午、没带分钟的中文数字，只有在句首或后面跟着“钟/整/开始”这类词时才算钟点。
 */
function findClock(clause: string): RegExpExecArray | null {
  const re = new RegExp(TIME, "g");
  for (let m = re.exec(clause); m; m = re.exec(clause)) {
    if (m[1] || m[3] !== undefined || /^\d/.test(m[2]!) || (m[4] !== undefined && /^(?:半|一刻|三刻)$|分$/.test(m[4]))) return m;
    const after = clause.slice(m.index + m[0].length);
    if (/^\s*[点儿]/.test(after)) continue; // 一点点、一点儿
    if (/^\s*(?:钟|整|开始|起|左右|以?前|以?后|之[前后])/.test(after) || LEAD.test(clause.slice(0, m.index))) return m;
  }
  return null;
}

/** 标题：去掉时间和连接词，留下要做的事 */
function titleOf(clause: string, time: { index: number; length: number } | null): string {
  // 紧贴在钟点前面的日期是时间的一部分，不进标题；别处的日期词（“周五要交的作业”）留着
  const text = time ? `${clause.slice(0, time.index).replace(DATE_BEFORE_TIME, "")} ${clause.slice(time.index + time.length)}` : clause;
  return text
    .replace(/^[\s、]*(?:然后|接着|之后|再|还有|另外|以及|和|并且)\s*/, "")
    .replace(/^\s*(?:今天|明天|后天|今晚|明晚)\s*/, "")
    .replace(/^\s*(?:在|从|于)\s*/, "")
    .replace(/\s*(?:的时候|期间)\s*/, " ")
    .replace(/[。.!！\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * durationOf：只说了开始时间的一件事，对得上已有任务时按它的估时排多久（由调用方查库，这里保持纯函数）。
 * 时长在解析时就定下来，接在后面的那一件才不会和它撞上。
 */
export function parseArrange(body: string, slot: ArrangeSlot | null, referenceDate: string, nowMinute: number | null, durationOf?: (title: string) => number | null): ArrangePiece[] {
  const all = clausesOf(body);
  const clauses = all.slice(0, MAX_PIECES);
  const pieces: ArrangePiece[] = [];
  const slotRange = slot ? ([toMin(slot.start), slot.end >= "24:00" ? DAY : toMin(slot.end)] as const) : null;
  const lengthOf = (title: string) => estimateFromText(title) ?? durationOf?.(title) ?? 60;
  const nextDay = (title: string, said: string) => `「${title}」说的「${said.trim()}」已经是第二天凌晨了，没有排。要排在后半夜，请说成“明天凌晨几点”`;
  let lastEnd: number | null = null;
  let lastDate = null as string | null;

  for (const clause of clauses) {
    const date: string = dateFromText(clause, referenceDate) ?? lastDate ?? slot?.date ?? referenceDate;
    // 没说上午/下午时的取舍：同一天里接着上一件 → 落在点选的空档里 → 今天已经过去的不选 → 8 点前算下午
    const pick = (am: number, pm: number): number => {
      if (lastEnd !== null && date === lastDate) return am >= lastEnd ? am : pm;
      if (slotRange && date === slot!.date) {
        const inAm = am >= slotRange[0] && am < slotRange[1];
        const inPm = pm >= slotRange[0] && pm < slotRange[1];
        if (inAm !== inPm) return inAm ? am : pm;
      }
      if (nowMinute !== null && date === referenceDate && am < nowMinute && pm >= nowMinute) return pm;
      return am < 8 * 60 ? pm : am;
    };

    const range = RANGE.exec(clause);
    if (range) {
      const title = titleOf(clause, { index: range.index, length: range[0].length });
      const start = resolve(parseNumber(range[2]!), minuteOf(range[3], range[4]), partOf(range[1]), pick);
      if (start === null) {
        pieces.push({ ok: false, title: title || clause, error: `没看懂「${range[0]}」是几点` });
        continue;
      }
      if (start >= DAY) {
        pieces.push({ ok: false, title: title || clause, error: nextDay(title || clause, new RegExp(TIME).exec(range[0])![0]) });
        continue;
      }
      // 结束钟点没另说上午/下午：跟开始在同一个半天，倒过来了再往后推半天（11点到1点 = 13:00）
      const endPart = partOf(range[5]);
      const sameHalfPm = start >= 12 * 60;
      let end = resolve(parseNumber(range[6]!), minuteOf(range[7], range[8]), endPart, (am, pm) => (sameHalfPm ? pm : am));
      if (end === null) {
        pieces.push({ ok: false, title: title || clause, error: `没看懂「${range[0]}」到几点` });
        continue;
      }
      if (!endPart && end < start && end + 12 * 60 <= DAY) end += 12 * 60;
      if (!title) {
        pieces.push({ ok: false, title: clause, error: `「${clause}」只有时间，没说要安排什么` });
        continue;
      }
      if (end > DAY) {
        pieces.push({ ok: false, title, error: `「${title}」的时间跨过了半夜，没有排。请分成两段说：到晚上12点为止一段，第二天凌晨起另一段` });
        continue;
      }
      if (end === start) {
        pieces.push({ ok: false, title, error: `「${title}」的时间是 ${hm(start)} 到 ${hm(end)}，开始和结束一样，没有排。告诉我到几点结束` });
        continue;
      }
      if (end < start) {
        pieces.push({ ok: false, title, error: `「${title}」的结束时间 ${hm(end)} 早于开始时间 ${hm(start)}，没有排。请再说一次起止时间` });
        continue;
      }
      pieces.push({ ok: true, title, date, start: hm(start), end: hm(end), timed: "range" });
      lastEnd = end;
      lastDate = date;
      continue;
    }

    const single = findClock(clause);
    if (single) {
      const title = titleOf(clause, { index: single.index, length: single[0].length });
      const start = resolve(parseNumber(single[2]!), minuteOf(single[3], single[4]), partOf(single[1]), pick);
      if (start === null || !title) {
        pieces.push({ ok: false, title: title || clause, error: start === null ? `没看懂「${single[0]}」是几点` : `「${clause}」只有时间，没说要安排什么` });
        continue;
      }
      if (start >= DAY) {
        pieces.push({ ok: false, title, error: nextDay(title, single[0]) });
        continue;
      }
      // 只有开始时间：话里说了时长按话里的，对得上已有任务按它的估时，否则一小时
      const end = Math.min(DAY, start + lengthOf(title));
      pieces.push({ ok: true, title, date, start: hm(start), end: hm(end), timed: "start" });
      lastEnd = end;
      lastDate = date;
      continue;
    }

    // 没写时间：接在上一件之后；没有上一件就用点选的空档
    const title = titleOf(clause, null);
    if (!title) continue;
    if (lastEnd !== null && lastDate === date) {
      const end = Math.min(DAY, lastEnd + lengthOf(title));
      pieces.push({ ok: true, title, date, start: hm(lastEnd), end: hm(end), timed: "start" });
      lastEnd = end;
      continue;
    }
    if (slot && date === slot.date) {
      pieces.push({ ok: true, title, date, start: slot.start, end: slot.end, timed: "none" });
      continue;
    }
    pieces.push({ ok: false, title, error: `「${title}」没说什么时候做：写上时间（比如“下午3点到4点”），或先点时间线上的一个空档` });
  }
  // 超出的不悄悄丢掉：单独说明哪几件没有排
  if (all.length > MAX_PIECES) {
    const dropped = all.slice(MAX_PIECES);
    const text = dropped.join("，");
    pieces.push({ ok: false, title: text, error: `一次最多安排 ${MAX_PIECES} 件事，后面 ${dropped.length} 件没有排：${text.length > 120 ? `${text.slice(0, 120)}…` : text}。请把它们再发一次` });
  }
  return pieces;
}

/** 正文里有没有写钟点（没点空档时，/安排 至少要有一个时间） */
export function hasClockTime(body: string): boolean {
  return clausesOf(body).some((clause) => RANGE.test(clause) || findClock(clause) !== null);
}
