import { addDays, localDateInTz, wallTimeToUtc } from "./time";

/**
 * ICS 子集确定性解析（MASTER-PLAN §3.1）：
 * 支持单日有起止的 VEVENT；时间可为 UTC（…Z）、带 TZID 或无时区（按实例时区）；
 * 重复规则支持 WEEKLY/DAILY + INTERVAL、BYDAY、COUNT/UNTIL、EXDATE，同日 RECURRENCE-ID 改单次时间；
 * 展开只到开始日之后 180 天。全天、跨夜/多日、跨日移动的例外和其他重复规则不支持：
 * 逐条列出原因，不静默忽略，也不拿 23:59 冒充全天。
 */

export type IcsEvent = { uid: string; title: string; date: string; localStart: string; localEnd: string };
export type IcsUnsupported = { title: string; reason: string };
export type IcsParseResult = { events: IcsEvent[]; skippedRecurring: number; unsupported: IcsUnsupported[] };

type Prop = { value: string; params: Record<string, string> };
type RawEvent = Record<string, Prop> & { __exdates?: Prop[] };

const MAX_EVENTS = 200;
const HORIZON_DAYS = 180;
const BYDAY: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

export function parseIcs(text: string, tz = "Asia/Shanghai"): IcsParseResult {
  const lines = unfold(text);
  const raws: RawEvent[] = [];
  let cur: RawEvent | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {} as RawEvent;
    else if (line === "END:VEVENT" && cur) {
      raws.push(cur);
      cur = null;
    } else if (cur) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const [name, ...paramParts] = line.slice(0, idx).split(";");
      const params: Record<string, string> = {};
      for (const p of paramParts) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      const prop = { value: line.slice(idx + 1).trim(), params };
      const key = name!.toUpperCase();
      if (key === "EXDATE") (cur.__exdates ??= []).push(prop);
      else cur[key] = prop;
    }
  }

  const events: IcsEvent[] = [];
  const unsupported: IcsUnsupported[] = [];
  let skippedRecurring = 0;
  // 同一 UID 的单次改时（RECURRENCE-ID）：按原定日期覆盖那一次
  const overrides = new Map<string, { start: string; end: string }>();
  for (const r of raws.filter((x) => x["RECURRENCE-ID"])) {
    const title = r.SUMMARY?.value ?? "未命名";
    const original = instantOf(r["RECURRENCE-ID"]!, tz);
    const start = r.DTSTART ? instantOf(r.DTSTART, tz) : null;
    const end = r.DTEND ? instantOf(r.DTEND, tz) : null;
    if (!original || !start || !end || "allDay" in original || "allDay" in start || "allDay" in end) {
      unsupported.push({ title, reason: "单次改期的时间读不出来" });
      continue;
    }
    const day = localDateInTz(new Date(original.ms), tz);
    if (localDateInTz(new Date(start.ms), tz) !== day || localDateInTz(new Date(end.ms), tz) !== day) {
      unsupported.push({ title, reason: `${day} 那一次被改到了别的日期：跨日移动的例外不支持，请单独告诉我` });
      continue;
    }
    overrides.set(`${r.UID?.value ?? ""}|${day}`, { start: hm(start.ms, tz), end: hm(end.ms, tz) });
  }

  for (const r of raws.filter((x) => !x["RECURRENCE-ID"])) {
    const title = (r.SUMMARY?.value ?? "").trim().slice(0, 200);
    if (!title) continue;
    const start = r.DTSTART ? instantOf(r.DTSTART, tz) : null;
    const end = r.DTEND ? instantOf(r.DTEND, tz) : null;
    if (!start) {
      unsupported.push({ title, reason: "开始时间读不出来（时区或格式不认识）" });
      continue;
    }
    if ("allDay" in start) {
      unsupported.push({ title, reason: "全天事件不支持：不会拿 00:00–23:59 冒充" });
      continue;
    }
    if (!end || "allDay" in end) {
      unsupported.push({ title, reason: "没有结束时间" });
      continue;
    }
    const date = localDateInTz(new Date(start.ms), tz);
    if (localDateInTz(new Date(end.ms), tz) !== date || end.ms <= start.ms) {
      unsupported.push({ title, reason: "跨夜或多日的事件不支持" });
      continue;
    }
    const uid = r.UID?.value ?? "";
    const startHm = hm(start.ms, tz);
    const endHm = hm(end.ms, tz);
    if (!r.RRULE) {
      events.push({ uid, title, date, localStart: startHm, localEnd: endHm });
      continue;
    }
    const dates = expand(r.RRULE.value, date, tz, r.__exdates ?? []);
    if (!dates) {
      skippedRecurring++;
      unsupported.push({ title, reason: `重复规则不支持（${r.RRULE.value.slice(0, 60)}）` });
      continue;
    }
    for (const d of dates) {
      const o = overrides.get(`${uid}|${d}`);
      events.push({ uid: `${uid}#${d}`, title, date: d, localStart: o?.start ?? startHm, localEnd: o?.end ?? endHm });
    }
  }
  return { events: events.slice(0, MAX_EVENTS), skippedRecurring, unsupported };
}

/** 折叠行展开（续行以空格/制表符开头） */
function unfold(text: string): string[] {
  const raw = text.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  for (const l of raw) {
    if (/^[ \t]/.test(l) && out.length) out[out.length - 1] += l.slice(1);
    else out.push(l);
  }
  return out.map((l) => l.trim()).filter(Boolean);
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 属性值 → 真实时刻：…Z 是 UTC，不当墙钟；TZID 按那个时区；无时区按实例时区 */
function instantOf(p: Prop, tz: string): { ms: number } | { allDay: true } | null {
  if (p.params.VALUE === "DATE" || /^\d{8}$/.test(p.value)) return { allDay: true };
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(p.value);
  if (!m) return null;
  if (m[7]) return { ms: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) };
  const zone = p.params.TZID ?? tz;
  if (!validTz(zone)) return null;
  return { ms: wallTimeToUtc(`${m[1]}-${m[2]}-${m[3]}`, `${m[4]}:${m[5]}`, zone).getTime() };
}

function hm(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
}

/** 展开受支持的重复规则为当地日期列表；不支持的规则返回 null */
function expand(rrule: string, startDate: string, tz: string, exdates: Prop[]): string[] | null {
  const parts = Object.fromEntries(rrule.split(";").map((kv) => kv.split("=").map((x) => x.trim().toUpperCase()) as [string, string]));
  const allowed = new Set(["FREQ", "INTERVAL", "BYDAY", "COUNT", "UNTIL", "WKST"]);
  if (Object.keys(parts).some((k) => !allowed.has(k))) return null;
  if (parts.FREQ !== "WEEKLY" && parts.FREQ !== "DAILY") return null;
  const interval = parts.INTERVAL ? Number(parts.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > 52) return null;
  const count = parts.COUNT ? Number(parts.COUNT) : null;
  if (count !== null && (!Number.isInteger(count) || count < 1)) return null;
  let until = addDays(startDate, HORIZON_DAYS);
  if (parts.UNTIL) {
    const u = instantOf({ value: parts.UNTIL, params: {} }, tz);
    const untilDate = !u ? null : "allDay" in u ? `${parts.UNTIL.slice(0, 4)}-${parts.UNTIL.slice(4, 6)}-${parts.UNTIL.slice(6, 8)}` : localDateInTz(new Date(u.ms), tz);
    if (!untilDate) return null;
    if (untilDate < until) until = untilDate;
  }
  const excluded = new Set<string>();
  for (const ex of exdates) {
    for (const v of ex.value.split(",")) {
      const i = instantOf({ value: v.trim(), params: ex.params }, tz);
      if (i && "ms" in i) excluded.add(localDateInTz(new Date(i.ms), tz));
      else if (/^\d{8}/.test(v.trim())) excluded.add(`${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`);
    }
  }
  const weekdayOf = (d: string) => ((new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  let days: number[] | null = null;
  if (parts.BYDAY) {
    if (parts.FREQ !== "WEEKLY") return null;
    days = [];
    for (const token of parts.BYDAY.split(",")) {
      if (!(token in BYDAY)) return null; // 带序数的 BYDAY（如 2MO）不支持
      days.push(BYDAY[token]!);
    }
  }
  const out: string[] = [];
  let produced = 0;
  if (parts.FREQ === "DAILY") {
    for (let d = startDate; d <= until && (count === null || produced < count); d = addDays(d, interval)) {
      produced++;
      if (!excluded.has(d)) out.push(d);
    }
    return out;
  }
  const weekStart = addDays(startDate, -(weekdayOf(startDate) - 1));
  const wanted = days ?? [weekdayOf(startDate)];
  for (let w = weekStart; w <= until && (count === null || produced < count); w = addDays(w, 7 * interval)) {
    for (const wd of [...wanted].sort((a, b) => a - b)) {
      const d = addDays(w, wd - 1);
      if (d < startDate || d > until || (count !== null && produced >= count)) continue;
      produced++;
      if (!excluded.has(d)) out.push(d);
    }
  }
  return out;
}
