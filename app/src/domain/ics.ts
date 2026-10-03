/**
 * ICS 子集确定性解析（MASTER-PLAN §3）：一次性 VEVENT（SUMMARY/DTSTART/DTEND/UID）。
 * 带 RRULE 的事件跳过并计数，不半解析。naive 时间按实例时区解释。
 */

export type IcsEvent = { uid: string; title: string; date: string; localStart: string; localEnd: string };
export type IcsParseResult = { events: IcsEvent[]; skippedRecurring: number };

export function parseIcs(text: string): IcsParseResult {
  const lines = unfold(text);
  const events: IcsEvent[] = [];
  let skippedRecurring = 0;
  let cur: Record<string, string> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = {};
    else if (line === "END:VEVENT" && cur) {
      if (cur.RRULE) skippedRecurring++;
      else {
        const e = toEvent(cur);
        if (e) events.push(e);
      }
      cur = null;
    } else if (cur) {
      const m = /^([A-Z-]+)[;:](.*)$/.exec(line);
      if (m) cur[m[1]!] = line.slice(line.indexOf(":") + 1).trim();
    }
  }
  return { events: events.slice(0, 200), skippedRecurring };
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

function toEvent(cur: Record<string, string>): IcsEvent | null {
  const title = cur.SUMMARY?.trim();
  const start = parseDt(cur.DTSTART ?? "");
  const end = parseDt(cur.DTEND ?? "");
  if (!title || !start || !end) return null;
  return { uid: cur.UID ?? "", title: title.slice(0, 200), date: start.date, localStart: start.time, localEnd: end.time };
}

/** DTSTART:20261008T140000（naive）→ {date, time}；带 Z 的 UTC 也按墙钟取（子集，文档化） */
function parseDt(raw: string): { date: string; time: string } | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/.exec(raw);
  if (!m) return null;
  return { date: `${m[1]}-${m[2]}-${m[3]}`, time: `${m[4]}:${m[5]}` };
}
