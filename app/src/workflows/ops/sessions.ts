import { getDb } from "@/repositories/db";
import { bumpPlanningRevision } from "@/repositories/proposals";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { addDays, instanceTimezone, localDateInTz, wallTimeToUtc } from "@/domain/time";
import { subtractIntervals, type Interval } from "@/domain/budget";
import { getPrefs, getSession, insertSession, listSessionsInRange } from "@/repositories/plan";
import { insertPracticeEntry } from "@/repositories/practice";
import crypto from "node:crypto";
import { HttpError } from "@/workflows/http";
import { nowDate } from "@/domain/clock";
import { dayLedger, eventsForDay } from "@/workflows/plan";

/**
 * 学习块操作（REPAIR-PLAN §4.5/§5.1.1）：主人明确要求时可直接改近期甚至锁定的指定块；
 * 同一个块原地移动（ID 不变、不复制任务）；不越过正式截止、课程和当日预算——做不到就说清缺什么。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;

const GAP_MS = 10 * 60000;
const PARTS: Record<string, [string, string]> = { morning: ["06:00", "12:00"], afternoon: ["12:00", "18:00"], evening: ["18:00", "24:00"], any: ["00:00", "24:00"] };
const PART_LABEL: Record<string, string> = { morning: "上午", afternoon: "下午", evening: "晚上", any: "" };

function wall(date: string, time: string, tz: string): number {
  return time >= "24:00" ? wallTimeToUtc(addDays(date, 1), "00:00", tz).getTime() : wallTimeToUtc(date, time, tz).getTime();
}

function label(ms: number, tz: string): string {
  const d = localDateInTz(new Date(ms), tz);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${t}`;
}

function taskOf(taskId: string): { title: string; dueAtMs: number | null } {
  const tz = instanceTimezone();
  const r = getDb().prepare(`SELECT title, due_kind, due_local_date, due_timezone, due_at FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
  const dueAtMs =
    r.due_kind === "instant" && r.due_at
      ? Date.parse(r.due_at as string)
      : r.due_kind === "date" && r.due_local_date
        ? wallTimeToUtc(addDays(r.due_local_date as string, 1), "00:00", (r.due_timezone as string) ?? tz).getTime()
        : null;
  return { title: r.title as string, dueAtMs };
}

export function applyRescheduleSession(cmd: Cmd<"reschedule_session">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const tz = instanceTimezone();
  const now = ctx.now ?? nowDate();
  const session = getSession(cmd.sessionId);
  if (!session || !["planned", "tentative", "in_progress"].includes(session.status)) throw new HttpError(404, "NOT_FOUND", "这个学习块不存在或已经结束");
  if (cmd.expectedVersion !== null && cmd.expectedVersion !== session.version) throw new HttpError(409, "STALE_VERSION", "这个学习块刚被改过，请按最新安排再说一次");
  const task = taskOf(session.taskId);
  const start = Date.parse(session.startUtc);
  const end = Date.parse(session.endUtc);

  // 进行中的块：已发生的投入留在原处，只把剩余部分挪走
  let minutes = cmd.durationMinutes ?? Math.round((end - start) / 60000);
  const elapsed = session.status === "in_progress" ? Math.max(0, Math.round((now.getTime() - start) / 60000)) : 0;
  const splitting = session.status === "in_progress" && elapsed >= 1;
  if (splitting && cmd.durationMinutes === null) minutes = Math.max(5, Math.round((end - start) / 60000) - elapsed);

  const targetDate = cmd.targetDate ?? localDateInTz(new Date(start), tz);
  const prefs = getPrefs();
  const [dayStart, dayEnd] = [wall(targetDate, "00:00", tz), wall(targetDate, "24:00", tz)];
  const others = listSessionsInRange(new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()).filter((s) => s.id !== session.id);
  const ledger = dayLedger(targetDate, now, prefs, tz, others);
  const busy = others.filter((s) => ["planned", "tentative", "in_progress"].includes(s.status)).map((s) => [Date.parse(s.startUtc) - GAP_MS, Date.parse(s.endUtc) + GAP_MS] as Interval);
  const need = minutes * 60000;
  let slot: number | null = null;

  if (cmd.startLocalTime) {
    // 主人给了具体钟点：只要不撞课程/固定活动/别的学习块就照办（用餐、时段模板由主人自己决定）
    slot = wall(targetDate, cmd.startLocalTime, tz);
    if (slot < now.getTime()) throw new HttpError(422, "IN_THE_PAST", `${label(slot, tz)} 已经过去了`);
    const clash = eventsForDay(targetDate, tz).find((e) => e.kind !== "pending" && e.interval[0] < slot! + need && e.interval[1] > slot!);
    if (clash) throw new HttpError(409, "SLOT_CONFLICT", `${label(slot, tz)} 开始的 ${minutes} 分钟会撞上「${clash.title}」（${label(clash.interval[0], tz).slice(-5)}–${label(clash.interval[1], tz).slice(-5)}）`);
    if (busy.some(([s, e]) => s + GAP_MS < slot! + need && e - GAP_MS > slot!)) throw new HttpError(409, "SLOT_CONFLICT", `${label(slot, tz)} 那段已经有别的学习安排`);
  } else {
    const [from, to] = PARTS[cmd.part]!;
    const window: Interval = [Math.max(wall(targetDate, from, tz), now.getTime()), wall(targetDate, to, tz)];
    const free = subtractIntervals(ledger.w, busy)
      .map(([s, e]) => [Math.max(s, window[0]), Math.min(e, window[1])] as Interval)
      .filter(([s, e]) => e > s);
    const fit = free.find(([s, e]) => e - s >= need);
    if (!fit) {
      const largest = Math.max(0, ...free.map(([s, e]) => Math.floor((e - s) / 60000)));
      const where = `${Number(targetDate.slice(5, 7))}/${Number(targetDate.slice(8, 10))}${PART_LABEL[cmd.part]}`;
      throw new HttpError(409, "NO_SLOT", largest > 0 ? `${where}最长的连续空档只有 ${largest} 分钟，放不下 ${minutes} 分钟` : `${where}没有可安排的空档${ledger.policy.noStudy ? "（这天设了不安排学习）" : ""}`);
    }
    slot = fit[0];
  }

  if (ledger.futureCapacity < minutes) {
    throw new HttpError(409, "OVER_BUDGET", `${Number(targetDate.slice(5, 7))}/${Number(targetDate.slice(8, 10))} 的学习预算只剩 ${ledger.futureCapacity} 分钟，放不下 ${minutes} 分钟；可以换一天，或告诉我这天的上限要调高`);
  }
  if (task.dueAtMs !== null && slot + need > task.dueAtMs) {
    throw new HttpError(409, "DEADLINE_CONFLICT", `「${task.title}」${label(task.dueAtMs, tz)} 截止，挪到 ${label(slot, tz)} 会晚于截止；截止不会自动顺延，要缩小范围还是换个更早的时间？`);
  }

  const nowIso = new Date().toISOString();
  const newStart = new Date(slot).toISOString();
  const newEnd = new Date(slot + need).toISOString();
  const reason = `你要求挪到这里（原 ${label(start, tz)}）`;
  if (splitting) {
    // 已学的部分按实际结束；剩余部分是新块
    db.prepare(`UPDATE plan_sessions SET end_utc = ?, status = 'completed', version = version + 1, updated_at = ? WHERE id = ?`).run(now.toISOString(), nowIso, session.id);
    changes.push({ entityKind: "plan_session", entityId: session.id, action: "update", before: { endUtc: session.endUtc, status: session.status }, after: { endUtc: now.toISOString(), status: "completed" }, beforeVersion: session.version, afterVersion: session.version + 1 });
    const id = insertSession({ taskId: session.taskId, startUtc: newStart, endUtc: newEnd, timezone: tz, batchId: "", reason, origin: "user" });
    changes.push({ entityKind: "plan_session", entityId: id, action: "create", after: { taskId: session.taskId, startUtc: newStart, endUtc: newEnd }, afterVersion: 1 });
    bumpPlanningRevision();
    return `「${task.title}」已学的 ${elapsed} 分钟保留；剩下 ${minutes} 分钟挪到 ${label(slot, tz)}–${label(slot + need, tz).slice(-5)}`;
  }
  db.prepare(`UPDATE plan_sessions SET start_utc = ?, end_utc = ?, origin = 'user', reason = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(newStart, newEnd, reason, nowIso, session.id);
  changes.push({
    entityKind: "plan_session",
    entityId: session.id,
    action: "update",
    before: { startUtc: session.startUtc, endUtc: session.endUtc, origin: session.origin, reason: session.reason },
    after: { startUtc: newStart, endUtc: newEnd, origin: "user", reason },
    beforeVersion: session.version,
    afterVersion: session.version + 1,
  });
  bumpPlanningRevision();
  const lengthNote = cmd.durationMinutes !== null && cmd.durationMinutes !== Math.round((end - start) / 60000) ? `，这次只留 ${minutes} 分钟（任务总需求不变）` : "";
  return `「${task.title}」由 ${label(start, tz)} 挪到 ${label(slot, tz)}–${label(slot + need, tz).slice(-5)}${lengthNote}`;
}

const STATE_ACTIONS: Record<string, { status?: string; locked?: boolean; from: string[]; label: string }> = {
  start: { status: "in_progress", from: ["planned", "tentative"], label: "已开始" },
  complete: { status: "completed", from: ["planned", "tentative", "in_progress"], label: "这一段已完成" },
  skip: { status: "skipped", from: ["planned", "tentative", "in_progress"], label: "这一段跳过，会另找时间" },
  lock: { locked: true, from: ["planned", "tentative", "in_progress"], label: "已锁定，不会被自动调整" },
  unlock: { locked: false, from: ["planned", "tentative", "in_progress"], label: "已解除锁定" },
};

/** 开始/完成/跳过/锁定/解锁。完成只完成这一段，不自动完成任务；给了实际分钟就记一条关联的实践 */
export function applySessionState(cmd: Cmd<"set_session_state">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const session = getSession(cmd.sessionId);
  if (!session) throw new HttpError(404, "NOT_FOUND", "学习块不存在");
  if (cmd.expectedVersion !== null && cmd.expectedVersion !== session.version) throw new HttpError(409, "STALE_VERSION", "学习块状态已变化，请刷新后再试");
  const action = STATE_ACTIONS[cmd.action]!;
  if (!action.from.includes(session.status)) throw new HttpError(409, "INVALID_STATE", "这个学习块已经结束，不能再改状态");
  const nextStatus = action.status ?? session.status;
  const nextLocked = action.locked ?? session.locked;
  if (nextStatus === session.status && nextLocked === session.locked) return `「${taskOf(session.taskId).title}」没有变化`;
  db.prepare(`UPDATE plan_sessions SET status = ?, locked = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(nextStatus, nextLocked ? 1 : 0, new Date().toISOString(), session.id);
  changes.push({ entityKind: "plan_session", entityId: session.id, action: "update", before: { status: session.status, locked: session.locked ? 1 : 0 }, after: { status: nextStatus, locked: nextLocked ? 1 : 0 }, beforeVersion: session.version, afterVersion: session.version + 1 });
  let extra = "";
  if (cmd.action === "complete" && cmd.actualMinutes !== null) {
    const occurredOn = localDateInTz(new Date(session.startUtc), instanceTimezone());
    const id = insertPracticeEntry({ occurredOn, actualMinutes: cmd.actualMinutes, note: cmd.note, taskId: session.taskId, planSessionId: session.id });
    changes.push({ entityKind: "practice_entry", entityId: id, action: "create", after: { occurredOn, actualMinutes: cmd.actualMinutes, taskId: session.taskId }, afterVersion: 1 });
    extra = `，实际 ${cmd.actualMinutes} 分钟`;
  }
  void ctx;
  bumpPlanningRevision();
  return `「${taskOf(session.taskId).title}」${action.label}${extra}`;
}

/** 主人指定“这段时间做这件事”：校验不撞课程/别的安排、不超当日预算、不晚于截止，然后原样排上 */
export function applyScheduleSession(cmd: Cmd<"schedule_session">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const tz = instanceTimezone();
  const now = ctx.now ?? nowDate();
  let taskId = cmd.taskId;
  let title = cmd.title ?? "";
  if (taskId) {
    const t = db.prepare(`SELECT title FROM tasks WHERE id = ? AND archived_at IS NULL AND status IN ('todo','doing','blocked')`).get(taskId) as { title: string } | undefined;
    if (!t) throw new HttpError(404, "NOT_FOUND", "要安排的任务不存在或已结束");
    title = t.title;
  } else {
    if (!cmd.title) throw new HttpError(422, "VALIDATION", "需要说明安排什么");
    taskId = crypto.randomUUID();
    const iso = new Date().toISOString();
    db.prepare(`INSERT INTO tasks (id, title, description, status, priority, estimate_minutes, due_kind, created_at, updated_at) VALUES (?, ?, '', 'todo', 'normal', ?, 'none', ?, ?)`).run(taskId, cmd.title, cmd.durationMinutes, iso, iso);
    changes.push({ entityKind: "task", entityId: taskId, action: "create", after: { title: cmd.title }, afterVersion: 1 });
  }
  const start = wall(cmd.date, cmd.startLocalTime, tz);
  const end = start + cmd.durationMinutes * 60000;
  if (start < now.getTime()) throw new HttpError(422, "IN_THE_PAST", `${label(start, tz)} 已经过去了`);
  const clash = eventsForDay(cmd.date, tz).find((e) => e.kind !== "pending" && e.interval[0] < end && e.interval[1] > start);
  if (clash) throw new HttpError(409, "SLOT_CONFLICT", `这段时间会撞上「${clash.title}」`);
  const [dayStart, dayEnd] = [wall(cmd.date, "00:00", tz), wall(cmd.date, "24:00", tz)];
  const others = listSessionsInRange(new Date(dayStart).toISOString(), new Date(dayEnd).toISOString()).filter((s) => ["planned", "tentative", "in_progress"].includes(s.status));
  if (others.some((s) => Date.parse(s.startUtc) < end && Date.parse(s.endUtc) > start)) throw new HttpError(409, "SLOT_CONFLICT", "这段时间已经有别的学习安排");
  const ledger = dayLedger(cmd.date, now, getPrefs(), tz);
  if (ledger.futureCapacity < cmd.durationMinutes) {
    throw new HttpError(409, "OVER_BUDGET", `${Number(cmd.date.slice(5, 7))}/${Number(cmd.date.slice(8, 10))} 的学习预算只剩 ${ledger.futureCapacity} 分钟，放不下 ${cmd.durationMinutes} 分钟；可以缩短、换一天，或告诉我这天的上限要调高`);
  }
  const task = taskOf(taskId);
  if (task.dueAtMs !== null && end > task.dueAtMs) throw new HttpError(409, "DEADLINE_CONFLICT", `「${title}」${label(task.dueAtMs, tz)} 截止，排在这里会晚于截止`);
  const id = insertSession({ taskId, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString(), timezone: tz, batchId: "", reason: "你指定排在这里", origin: "user" });
  changes.push({ entityKind: "plan_session", entityId: id, action: "create", after: { taskId, startUtc: new Date(start).toISOString(), endUtc: new Date(end).toISOString() }, afterVersion: 1 });
  bumpPlanningRevision();
  return `「${title}」排在 ${label(start, tz)}–${label(end, tz).slice(-5)}`;
}
