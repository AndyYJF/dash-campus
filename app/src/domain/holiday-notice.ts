import crypto from "node:crypto";

/**
 * 国务院办公厅年度节假日安排通知的确定性解析（ACADEMIC-CALENDAR-AND-HOLIDAYS §4）。
 * 只解析通知原文里写明的日期；括号里的星期必须与该年该日的真实星期一致、“共N天”必须与区间长度一致，
 * 任何一处对不上就整体失败——不猜年份、不补全、不预测。
 */

export type HolidayDay = { localDate: string; name: string; kind: "holiday" | "adjusted_workday" };
export type HolidayNotice = { year: number; title: string; publishedAt: string | null; days: HolidayDay[]; revisionHash: string };
export type HolidayParseResult = { ok: true; notice: HolidayNotice } | { ok: false; error: string };

const WEEKDAY = ["日", "一", "二", "三", "四", "五", "六"];

function iso(year: number, month: number, day: number): string | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function weekdayOf(date: string): string {
  return WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** 从网页 HTML 取正文文字（去脚本/样式/标签），不解释其中任何指令 */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t　]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

/** 取“一、元旦：……”到下一节之间的正文；只认通知里出现的条目 */
function sections(text: string): Array<{ name: string; body: string }> {
  const out: Array<{ name: string; body: string }> = [];
  const re = /[一二三四五六七八九十]+、\s*([^：:\n]{1,8})[：:]\s*/g;
  const marks: Array<{ name: string; start: number; bodyStart: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) marks.push({ name: m[1]!.trim(), start: m.index, bodyStart: m.index + m[0].length });
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1]!.start : text.length;
    out.push({ name: marks[i]!.name, body: text.slice(marks[i]!.bodyStart, end) });
  }
  return out;
}

export function parseHolidayNotice(input: string): HolidayParseResult {
  const text = input.replace(/\r/g, "");
  const titleMatch = /国务院办公厅关于\s*(\d{4})\s*年\s*部分节假日安排的通知/.exec(text.replace(/\n/g, ""));
  if (!titleMatch) return { ok: false, error: "不是国务院办公厅年度节假日安排通知（没有找到标题和年份）" };
  const year = Number(titleMatch[1]);
  const published = /(?:发布日期|成文日期)[：:\s]*\n?\s*(\d{4})年(\d{1,2})月(\d{1,2})日/.exec(text);
  const publishedAt = published ? iso(Number(published[1]), Number(published[2]), Number(published[3])) : null;

  const days = new Map<string, HolidayDay>();
  const secs = sections(text).filter((s) => /放假/.test(s.body));
  if (!secs.length) return { ok: false, error: "通知正文里没有找到放假安排条目" };

  for (const sec of secs) {
    const body = sec.body.replace(/\n/g, "");
    // 放假区间：M月D日（…周X）至[M月]D日（…周X）放假[调休]，共N天；或单日
    const range = /(\d{1,2})月(\d{1,2})日（([^）]*)）(?:至(?:(\d{1,2})月)?(\d{1,2})日（([^）]*)）)?放假(?:调休)?，共(\d+)天/.exec(body);
    if (!range) return { ok: false, error: `「${sec.name}」的放假日期没有读懂，原文已保留` };
    const startMonth = Number(range[1]);
    const start = iso(year, startMonth, Number(range[2]));
    const endMonth = range[4] ? Number(range[4]) : startMonth;
    const end = range[5] ? iso(year, endMonth, Number(range[5])) : start;
    if (!start || !end || end < start) return { ok: false, error: `「${sec.name}」的日期不合法` };
    const check = (date: string, label: string): string | null => {
      const wd = /周([日一二三四五六])/.exec(label);
      return wd && wd[1] !== weekdayOf(date) ? `「${sec.name}」写的是周${wd[1]}，但 ${date} 是周${weekdayOf(date)}；年份或日期对不上` : null;
    };
    const problem = check(start, range[3]!) ?? (range[6] ? check(end, range[6]) : null);
    if (problem) return { ok: false, error: problem };
    const span: string[] = [];
    for (let d = new Date(`${start}T00:00:00Z`); d.toISOString().slice(0, 10) <= end; d.setUTCDate(d.getUTCDate() + 1)) span.push(d.toISOString().slice(0, 10));
    if (span.length !== Number(range[7])) return { ok: false, error: `「${sec.name}」写共 ${range[7]} 天，但区间是 ${span.length} 天` };
    for (const d of span) days.set(d, { localDate: d, name: sec.name, kind: "holiday" });

    // 调整上班日：放假句之后的“M月D日（周X）[、M月D日（周X）]上班”
    const rest = body.slice(range.index + range[0].length);
    const work = /((?:\d{1,2}月\d{1,2}日（[^）]*）[、，]?)+)上班/.exec(rest);
    if (work) {
      for (const m of work[1]!.matchAll(/(\d{1,2})月(\d{1,2})日（([^）]*)）/g)) {
        const date = iso(year, Number(m[1]), Number(m[2]));
        if (!date) return { ok: false, error: `「${sec.name}」的上班日期不合法` };
        const bad = check(date, m[3]!);
        if (bad) return { ok: false, error: bad };
        days.set(date, { localDate: date, name: sec.name, kind: "adjusted_workday" });
      }
    }
  }
  const list = [...days.values()].sort((a, b) => (a.localDate < b.localDate ? -1 : 1));
  const revisionHash = crypto.createHash("sha256").update(JSON.stringify({ year, list })).digest("hex").slice(0, 32);
  return { ok: true, notice: { year, title: `国务院办公厅关于${year}年部分节假日安排的通知`, publishedAt, days: list, revisionHash } };
}

/** 只有发布机关域名算官方来源；其他一律按第三方线索处理，不自动改课程 */
export function isOfficialHolidaySource(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "gov.cn" || host.endsWith(".gov.cn");
  } catch {
    return false;
  }
}
