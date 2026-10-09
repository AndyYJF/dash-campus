import { getDb } from "@/repositories/db";
import { addDays, mondayOf } from "@/domain/time";
import { dateFromText } from "@/domain/task-text";
import { dashboardSnapshot } from "./snapshot";
import { readReviewPage, readReviewById, reviewReadText } from "./review-read";

export type ReadLink = { label: string; href: "/today" | "/week" | "/direction" | "/settings" | "/reviews" };
export type ReadAnswer = { text: string; links: ReadLink[] };
type Env = { referenceDate: string; now: Date; tz: string; selected?: { kind: string; id: string } | null };

function dateRange(text: string, date: string): string[] {
  if (/下周|本周|这周|上周/.test(text)) {
    const monday = addDays(mondayOf(date), /下周/.test(text) ? 7 : /上周/.test(text) ? -7 : 0);
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  }
  const start = dateFromText(text, date) ?? date;
  return Array.from({ length: /每天|每日|一周|七天|7天|几天|未来|接下来/.test(text) ? 7 : 1 }, (_, i) => addDays(start, i));
}

/** Reads the same facts/ledger as the pages; no commands, scheduling, model, or journal writes. */
export function answerReadRequest(text: string, env: Env): ReadAnswer {
  const db = getDb();
  const time = (iso: string) => new Intl.DateTimeFormat("en-GB", { timeZone: env.tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
  const titles = (rows: { title: string }[]) => rows.map((r) => `• ${r.title}`).join("\n");
  const answer = (body: string, href: ReadLink["href"], label: string): ReadAnswer => ({ text: body, links: [{ href, label }] });
  if (/复盘|周报/.test(text)) {
    const dates = dateRange(text, env.referenceDate);
    const explicitPeriod = /下周|本周|这周|上周/.test(text) || dateFromText(text, env.referenceDate) !== null;
    const selected = env.selected?.kind === "review" ? readReviewById(env.selected.id, env.tz) : null;
    const page = readReviewPage({ timezone: env.tz, ...(explicitPeriod ? { dateFrom: dates[0], dateTo: dates.at(-1) } : {}) }, 0, 1);
    const review = selected ?? (page.items[0] ? readReviewById(page.items[0].id, env.tz) : null);
    if (!review) return answer(`没有找到${explicitPeriod ? `${dates[0]}–${dates.at(-1)} 的` : "已保存的"}复盘。这里只查看，没有重新生成；需要生成时可以另行提出。`, "/reviews", "打开复盘");
    const stored = reviewReadText(review);
    return answer(stored.length > 6000 ? `${stored.slice(0, 6000)}\n\n内容较长，这里显示前 6000 字；完整内容请打开复盘。` : stored, "/reviews", "打开已有复盘");
  }
  if (/空闲|空余|可用|剩余.*时间|还有.*(?:时间|空档)|预算|空档/.test(text)) {
    const lines = dateRange(text, env.referenceDate).map((date) => {
      const day = dashboardSnapshot(date, env.now).today;
      return `${date}：课程占用 ${day.courseMinutes} 分钟；学习预算 ${day.budget.cDay} 分钟，已记录学习 ${day.budget.actualMinutes} 分钟，未来学习承诺 ${day.budget.committedFutureMinutes} 分钟；剩余学习预算 ${day.budget.futureBudget} 分钟，可用于学习的剩余容量 ${day.budget.futureCapacity} 分钟${day.budget.source === "tentative" ? "（作息暂定）" : ""}。`;
    });
    return answer(`按当前账本读取；学习预算不等于全部自由时间：\n${lines.join("\n")}`, "/week", "打开本周时间轴");
  }
  if (/安排|日程|时间表|课表|课程|(?:今天|明天|每天|每日).*做什么/.test(text)) {
    const coursesOnly = /课表|课程/.test(text) && !/安排|日程|时间表/.test(text);
    const dates = dateRange(text, env.referenceDate);
    const lines = dates.map((date) => {
      const day = dashboardSnapshot(date, env.now).today;
      const events = day.events.filter((e) => !coursesOnly || e.kind === "course").map((e) => ({ start: e.startUtc, line: `${time(e.startUtc)}–${time(e.endUtc)} ${e.kind === "course" ? "课程" : "固定活动"}：${e.title}${e.location ? `（${e.location}）` : ""}` }));
      if (!coursesOnly) events.push(...day.sessions.filter((s) => ["planned", "tentative", "in_progress", "completed"].includes(s.status)).map((s) => ({ start: s.startUtc, line: `${time(s.startUtc)}–${time(s.endUtc)} 学习安排：${s.title}${s.status === "completed" ? "（已完成）" : s.status === "tentative" ? "（暂定）" : s.status === "in_progress" ? "（进行中）" : ""}` })));
      events.sort((a,b) => a.start.localeCompare(b.start));
      return `${date}${day.calendar.teachingWeek ? ` · 第 ${day.calendar.teachingWeek} 教学周` : ""}\n${events.length ? events.map(e => `• ${e.line}`).join("\n") : `• 没有${coursesOnly ? "课程" : "课程、固定活动或学习安排"}`}${!coursesOnly ? `\n• 学习预算 ${day.budget.cDay} 分钟，剩余预算 ${day.budget.futureBudget} 分钟${day.budget.source === "tentative" ? "（作息暂定）" : ""}` : ""}${!day.calendar.civilKnown ? "\n• 节假日事实尚未核对" : ""}`;
    });
    return answer(`当前${coursesOnly ? "课表" : "时间安排"}（只查看，没有修改）：\n${lines.join("\n\n")}`, dates.length === 1 ? "/today" : "/week", dates.length === 1 ? "打开今日页面" : "打开本周时间轴");
  }
  if (/任务|待办|事项/.test(text)) {
    const selected = env.selected?.kind === "task" ? env.selected.id : null;
    const rows = (selected ? db.prepare("SELECT title,status,task_kind FROM tasks WHERE id=? AND archived_at IS NULL").all(selected) : db.prepare("SELECT title,status,task_kind FROM tasks WHERE status IN ('todo','doing','blocked') AND archived_at IS NULL ORDER BY priority DESC,created_at DESC LIMIT 20").all()) as { title: string; status: string; task_kind: string }[];
    const total = selected ? rows.length : (db.prepare("SELECT COUNT(*) n FROM tasks WHERE status IN ('todo','doing','blocked') AND archived_at IS NULL").get() as { n: number }).n;
    return answer(rows.length ? `当前${selected ? "选中事项" : `未完成事项 ${total} 条${total > 20 ? "（显示最近 20 条）" : ""}`}：\n${rows.map(r => `• ${r.title}：${({todo:"待办",doing:"进行中",blocked:"受阻",done:"已完成",cancelled:"已取消"} as Record<string,string>)[r.status] ?? r.status} · ${r.task_kind}`).join("\n")}` : selected ? "选中的事项已不存在或已归档，没有修改任何记录。" : "当前没有未完成事项。", "/today", "打开待处理事项");
  }
  if (/项目|方向|目标|进展|状态|做了什么|学了多久/.test(text)) {
    const projects = db.prepare("SELECT title,status FROM projects WHERE archived_at IS NULL ORDER BY created_at DESC LIMIT 10").all() as { title: string; status: string }[];
    const goals = db.prepare("SELECT title FROM goals WHERE archived_at IS NULL AND status!='completed' ORDER BY priority DESC LIMIT 5").all() as { title: string }[];
    const practice = db.prepare("SELECT occurred_on,note,actual_minutes FROM practice_entries ORDER BY occurred_on DESC,created_at DESC LIMIT 5").all() as { occurred_on: string; note: string; actual_minutes: number | null }[];
    return answer(`当前目标：\n${titles(goals) || "尚未设置"}\n项目：\n${projects.map(r => `• ${r.title}（${r.status}）`).join("\n") || "尚无项目"}\n最近实践：\n${practice.map(r => `• ${r.occurred_on} ${r.note}（${r.actual_minutes === null ? "未报告用时" : `${r.actual_minutes} 分钟`}）`).join("\n") || "还没有记录，不能据此判断进展"}`, "/direction", "打开方向与实践");
  }
  if (/规则|作息|偏好|设置/.test(text)) {
    const p = dashboardSnapshot(env.referenceDate, env.now).policy;
    return answer(`当前作息${p.status === "tentative" ? "（暂定，尚未确认）" : ""}：工作日 ${p.workdayStart}–${p.workdayEnd}，周末 ${p.weekendStart}–${p.weekendEnd}；每日学习上限 ${p.dailyLimitMinutes} 分钟。\n这里只读取设置，没有确认或调整。`, "/settings", "打开设置");
  }
  return { text: "这是一条查看请求，没有创建任务或修改安排。还不确定你想看哪类数据：时间安排、可用学习时间、课表、待办、项目进展，还是作息规则？例如“查看本周时间安排”。", links: [{href:"/today",label:"打开今日"},{href:"/week",label:"打开本周"}] };
}
