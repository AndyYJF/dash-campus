import { dateFromText, estimateFromText, parseNumber } from "./task-text";

/**
 * “/安排 …” 的正文解析（纯函数）：一句话里可以有几件事，每件事可以自带时间。
 * - “下午3点到4点写微积分作业”：按话里的起止时间排，不是排在空档开头；
 * - “下午3点写微积分”：只有开始时间，时长交给后面按估时决定；
 * - 没写时间：接在上一件之后，或排在点选的空档开头；
 * - 起止相同或倒着的时间不猜，原样指出。
 * 没写上午/下午的钟点按上下文判断：先沿用前一件的时段，再看哪个落在点选的空档里，最后才按“8 点前算下午”。
 */

export type ArrangeSlot = { date: string; start: string; end: string };
export type ArrangePiece =
  | { ok: true; title: string; date: string; start: string; end: string; timed: "range" | "start" | "none" }
  | { ok: false; title: string; error: string };

const NUM = String.raw`\d{1,2}|[零一二两三四五六七八九十]{1,3}`;
const PART = String.raw`凌晨|清晨|早上|早晨|上午|中午|下午|傍晚|晚上|今晚|明晚`;
const TIME = String.raw`(${PART})?\s*(${NUM})\s*(?:[:：]\s*(\d{2})|点\s*(半|一刻|三刻|(?:${NUM})\s*分?)?)`;
const RANGE = new RegExp(`${TIME}\\s*(?:到|至|-|–|—|~|～)\\s*${TIME}`);
const SINGLE = new RegExp(TIME);
const MAX_PIECES = 6;

type Half = "am" | "pm";
const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

function minuteOf(clock: string | undefined, dot: string | undefined): number {
  if (clock) return Number(clock);
  if (!dot) return 0;
  if (dot === "半") return 30;
  if (dot === "一刻") return 15;
  if (dot === "三刻") return 45;
  return parseNumber(dot.replace(/分/, "").trim());
}

function halfOf(part: string | undefined): Half | "noon" | null {
  if (!part) return null;
  if (/下午|傍晚|晚上|今晚|明晚/.test(part)) return "pm";
  if (part === "中午") return "noon";
  return "am";
}

/** 钟点 → 当天分钟。half 为空表示话里没说上午还是下午，由 pick 在两种读法里选 */
function resolve(hour: number, minute: number, half: Half | "noon" | null, pick: (am: number, pm: number) => number): number | null {
  if (!Number.isInteger(hour) || hour > 24 || !Number.isInteger(minute) || minute > 59) return null;
  if (hour >= 13) return (hour === 24 ? 0 : hour) * 60 + minute;
  if (half === "pm") return (hour === 12 ? 12 : hour + 12) * 60 + minute;
  if (half === "noon") return (hour <= 2 ? hour + 12 : hour) * 60 + minute; // 中午1点 = 13:00
  if (half === "am") return (hour === 12 ? 0 : hour) * 60 + minute;
  if (hour === 12) return 12 * 60 + minute;
  return pick(hour * 60 + minute, (hour + 12) * 60 + minute);
}

/** 标题：去掉时间和连接词，留下要做的事 */
function titleOf(clause: string, timeText: string): string {
  return clause
    .replace(timeText, " ")
    .replace(/^[\s、]*(?:然后|接着|之后|再|还有|另外|以及|和|并且)\s*/, "")
    .replace(/^\s*(?:今天|明天|后天|今晚|明晚)\s*/, "")
    .replace(/^\s*(?:在|从|于)\s*/, "")
    .replace(/\s*(?:的时候|期间)\s*/, " ")
    .replace(/[。.!！\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseArrange(body: string, slot: ArrangeSlot | null, referenceDate: string, nowMinute: number | null): ArrangePiece[] {
  const clauses = body
    .split(/[，,；;。\n]+/)
    .map((c) => c.trim())
    .filter(Boolean)
    .slice(0, MAX_PIECES);
  const pieces: ArrangePiece[] = [];
  const slotRange = slot ? ([toMin(slot.start), slot.end >= "24:00" ? 1440 : toMin(slot.end)] as const) : null;
  let lastHalf: Half | null = null;
  let lastEnd: number | null = null;
  let lastDate = null as string | null;

  for (const clause of clauses) {
    const date: string = dateFromText(clause, referenceDate) ?? lastDate ?? slot?.date ?? referenceDate;
    // 没说上午/下午时的取舍：接着上一件 → 落在点选的空档里 → 今天已经过去的不选 → 8 点前算下午
    const pick = (am: number, pm: number): number => {
      if (lastEnd !== null && date === lastDate) return am >= lastEnd ? am : pm;
      if (lastHalf) return lastHalf === "pm" ? pm : am;
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
      const title = titleOf(clause, range[0]);
      const startHalf = halfOf(range[1]);
      const start = resolve(parseNumber(range[2]!), minuteOf(range[3], range[4]), startHalf, pick);
      if (start === null) {
        pieces.push({ ok: false, title: title || clause, error: `没看懂「${range[0]}」是几点` });
        continue;
      }
      // 结束钟点没另说上午/下午：跟开始在同一个半天，倒过来了再往后推半天（11点到1点 = 13:00）
      const endHalf = halfOf(range[5]);
      const sameHalf: Half = start >= 12 * 60 ? "pm" : "am";
      let end = resolve(parseNumber(range[6]!), minuteOf(range[7], range[8]), endHalf ?? null, (am, pm) => (sameHalf === "pm" ? pm : am));
      if (end === null) {
        pieces.push({ ok: false, title: title || clause, error: `没看懂「${range[0]}」到几点` });
        continue;
      }
      if (!endHalf && end < start && end + 12 * 60 <= 24 * 60) end += 12 * 60;
      if (!title) {
        pieces.push({ ok: false, title: clause, error: `「${clause}」只有时间，没说要安排什么` });
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
      lastHalf = end >= 12 * 60 ? "pm" : "am";
      lastEnd = end;
      lastDate = date;
      continue;
    }

    const single = SINGLE.exec(clause);
    if (single) {
      const title = titleOf(clause, single[0]);
      const start = resolve(parseNumber(single[2]!), minuteOf(single[3], single[4]), halfOf(single[1]), pick);
      if (start === null || !title) {
        pieces.push({ ok: false, title: title || clause, error: start === null ? `没看懂「${single[0]}」是几点` : `「${clause}」只有时间，没说要安排什么` });
        continue;
      }
      // 只有开始时间：话里说了时长就按它算结束，否则先按一小时占位，由后面按任务估时决定
      const said = estimateFromText(title);
      const end = Math.min(24 * 60, start + (said ?? 60));
      pieces.push({ ok: true, title, date, start: hm(start), end: hm(end), timed: "start" });
      lastHalf = start >= 12 * 60 ? "pm" : "am";
      lastEnd = end;
      lastDate = date;
      continue;
    }

    // 没写时间：接在上一件之后；没有上一件就用点选的空档
    const title = titleOf(clause, "");
    if (!title) continue;
    if (lastEnd !== null && lastDate === date) {
      const said = estimateFromText(title);
      const end = Math.min(24 * 60, lastEnd + (said ?? 60));
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
  return pieces;
}

/** 正文里有没有写钟点（没点空档时，/安排 至少要有一个时间） */
export function hasClockTime(body: string): boolean {
  return SINGLE.test(body);
}
