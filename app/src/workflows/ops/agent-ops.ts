import { getDb } from "@/repositories/db";
import { bumpPlanningRevision } from "@/repositories/proposals";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { DIGEST_JOB_TYPE } from "@/contracts/digests";
import { addDays, instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { nowDate } from "@/domain/clock";
import { createJob } from "@/repositories/jobs";
import { getIntake } from "@/repositories/intakes";
import { getTopic, listTopics } from "@/repositories/exploration";
import { isRestoredHold } from "@/repositories/instance";
import { getConfig } from "@/config";
import { HttpError } from "@/workflows/http";
import { startReview } from "@/workflows/review";
import { archiveTopic, createTopic, updateTopic } from "@/workflows/topics";
import { cancelIntake } from "@/workflows/intake";

/**
 * 复盘、定期探索、即时摘要、取消处理、固定活动修改（AGENT-INTERFACE-CONTRACT §4）。
 * 都复用既有 workflow（复盘/探索/摘要的可靠任务与投递状态机不变），这里只做注册操作的入口与结果说明。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;
const WEEKDAY = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"];
const md = (d: string) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;

/** 按需复盘：只生成复盘与建议，建议不会自动执行 */
export function applyRequestReview(cmd: Cmd<"request_review">, ctx: CommandContext): { summary: string; effectBatchId: string } {
  const tz = instanceTimezone();
  const today = localDateInTz(ctx.now ?? nowDate(), tz);
  const monday = cmd.localMonday ? mondayOf(cmd.localMonday) : cmd.week === "this" ? mondayOf(today) : addDays(mondayOf(today), -7);
  if (monday > today) throw new HttpError(422, "VALIDATION", "那一周还没开始，没有可复盘的内容");
  const running = getDb().prepare(`SELECT 1 FROM reviews WHERE local_monday = ? AND status IN ('queued','generating')`).get(monday);
  const r = startReview(monday, "manual");
  if (!r.ok) throw new HttpError(409, r.code, r.message);
  const range = `${md(monday)}–${md(addDays(monday, 6))}`;
  return {
    summary: running
      ? `${range} 这一周的复盘已经在生成了，完成后在「复盘」页看到`
      : `开始整理 ${range} 这一周的复盘：只用这一周已记录的事实，完成后在「复盘」页看到。里面的建议要你点头才会执行，不会自动改安排。`,
    effectBatchId: "",
  };
}

/** 定期探索的关注方向：新建/改时间/停用。停用后已有候选和记录都保留 */
export function applyConfigureExploration(cmd: Cmd<"configure_exploration">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const snapshot = (t: { title: string; purpose: string; enabled: boolean; weekday: number; localTime: string; nextRunAt: string | null; archivedAt: string | null }) => ({
    title: t.title,
    purpose: t.purpose,
    enabled: t.enabled ? 1 : 0,
    weekday: t.weekday,
    localTime: t.localTime,
    nextRunAt: t.nextRunAt,
    archivedAt: t.archivedAt,
  });
  const when = (t: { weekday: number; localTime: string }) => `每${WEEKDAY[t.weekday]} ${t.localTime}`;
  if (!cmd.topicId) {
    if (!cmd.title) throw new HttpError(422, "VALIDATION", "需要说明关注什么方向");
    const same = listTopics().find((t) => !t.archivedAt && t.title === cmd.title);
    if (same) throw new HttpError(409, "DUPLICATE", `已经有「${same.title}」这个关注方向了（${same.enabled ? when(same) : "目前停用"}）`);
    const t = createTopic({ title: cmd.title, purpose: cmd.purpose ?? "", sourcePreference: "", enabled: cmd.enabled ?? true, weekday: cmd.weekday ?? 6, localTime: cmd.localTime ?? "09:00" });
    // 撤销“新建”= 停用并归档（可能已经有探索记录引用它，不能直接删行）
    changes.push({ entityKind: "exploration_topic", entityId: t.id, action: "update", before: { enabled: 0, nextRunAt: null, archivedAt: t.createdAt }, after: snapshot(t), afterVersion: t.version });
    return t.enabled
      ? `以后${when(t)}帮你找一次「${t.title}」方向的候选：每次最多 3 个、都带出处，放在「方向」页；没有新东西就不打扰。受每日模型和搜索上限约束，不会替你报名或承诺投入。`
      : `记下了关注方向「${t.title}」，目前不定期找；需要时说“每周六帮我找一次”就开始。`;
  }
  const current = getTopic(cmd.topicId);
  if (!current || current.archivedAt) throw new HttpError(404, "NOT_FOUND", "这个关注方向不存在或已停用");
  if (cmd.archive) {
    const r = archiveTopic(current.id, current.version);
    if (r === "not_found" || r === "conflict") throw new HttpError(409, "STALE_VERSION", "这个关注方向刚被改过，请再说一次");
    changes.push({ entityKind: "exploration_topic", entityId: current.id, action: "update", before: snapshot(current), after: snapshot(r), afterVersion: r.version });
    return `不再定期找「${current.title}」了；之前找到的候选和记录都还在。`;
  }
  const patch = {
    ...(cmd.title !== undefined && cmd.title !== current.title ? { title: cmd.title } : {}),
    ...(cmd.purpose !== undefined && cmd.purpose !== current.purpose ? { purpose: cmd.purpose } : {}),
    ...(cmd.enabled !== undefined && cmd.enabled !== current.enabled ? { enabled: cmd.enabled } : {}),
    ...(cmd.weekday !== undefined && cmd.weekday !== current.weekday ? { weekday: cmd.weekday } : {}),
    ...(cmd.localTime !== undefined && cmd.localTime !== current.localTime ? { localTime: cmd.localTime } : {}),
  };
  if (!Object.keys(patch).length) return `「${current.title}」没有变化`;
  const r = updateTopic(current.id, { expectedVersion: current.version, ...patch });
  if (r === "not_found" || r === "conflict") throw new HttpError(409, "STALE_VERSION", "这个关注方向刚被改过，请再说一次");
  changes.push({ entityKind: "exploration_topic", entityId: current.id, action: "update", before: snapshot(current), after: snapshot(r), afterVersion: r.version });
  return r.enabled ? `「${r.title}」改为${when(r)}找一次；还没开始的旧一轮已作废` : `「${r.title}」暂停定期找；候选和记录保留，随时可以恢复`;
}

/** 现在发一份摘要给主人本人：走既有的可靠投递，已发出的邮件不能撤回 */
export function applyRequestOwnerDigest(cmd: Cmd<"request_owner_digest">, ctx: CommandContext): { summary: string; effectBatchId: string } {
  if (isRestoredHold()) throw new HttpError(409, "RESTORED_HOLD", "实例刚从备份恢复，还在保持期：这段时间不对外发邮件");
  const cfg = getConfig();
  if (!(cfg.SMTP_HOST && cfg.SMTP_USER && cfg.SMTP_PASSWORD && cfg.MAIL_FROM && cfg.MAIL_TO)) {
    throw new HttpError(409, "MAIL_NOT_CONFIGURED", "邮件还没配置完整（发件服务或收件邮箱缺失），现在发不出去；内容可以直接在页面上看");
  }
  const now = ctx.now ?? nowDate();
  const tz = instanceTimezone();
  const date = localDateInTz(now, tz);
  // 同一分钟内重复说只排一次
  const dedupeKey = `digest:manual:${cmd.kind}:${date}:${new Date().toISOString().slice(0, 16)}`;
  const existed = Boolean(getDb().prepare(`SELECT 1 FROM jobs WHERE dedupe_key = ?`).get(dedupeKey));
  createJob({ type: DIGEST_JOB_TYPE, dedupeKey, runAt: new Date().toISOString(), payload: { kind: cmd.kind, date, manual: true } });
  return {
    summary: `${existed ? "刚才已经安排过" : "已安排"}发送${cmd.kind === "weekly" ? "本周" : "今天的"}摘要，只发到你自己的邮箱。服务器接收不等于已进收件箱，投递状态在「通知」页可查；发出后不能撤回。`,
    effectBatchId: "",
  };
}

/** 停止处理一份还没处理完的投递：没执行的不再执行；已生效的变化保留，要撤回用撤销 */
export function applyCancelOperation(cmd: Cmd<"cancel_operation">): { summary: string; effectBatchId: string } {
  const intake = getIntake(cmd.intakeId);
  if (!intake) throw new HttpError(404, "NOT_FOUND", "没找到那份投递");
  if (intake.status === "cancelled") return { summary: "那份已经停止处理了", effectBatchId: "" };
  const r = cancelIntake(intake.id, intake.version);
  if (r.kind === "completed") throw new HttpError(409, "ALREADY_COMPLETED", "那份已经处理完了，没有可取消的部分；要撤回已经生效的变化，直接说“撤销”");
  if (r.kind !== "cancelled") throw new HttpError(409, "STALE_VERSION", "那份投递的状态刚变过，请再说一次");
  return { summary: "已停止处理那份材料：还没执行的部分不再执行；已经生效的变化保留，可以单独撤销。原件还在。", effectBatchId: "" };
}

type FixedRow = { id: string; title: string; weekday: number; local_start: string; local_end: string; timezone: string; event_date: string | null; valid_from: string | null; valid_until: string | null; version: number };

/** 非课程的固定活动：改名、改星期/日期/钟点，或以后不再占用。课程走课表与停课/调课，不在这里改 */
export function applyUpdateFixedEvent(cmd: Cmd<"update_fixed_event">, _ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const row = db.prepare(`SELECT id, title, weekday, local_start, local_end, timezone, event_date, valid_from, valid_until, version FROM fixed_events WHERE id = ?`).get(cmd.eventId) as FixedRow | undefined;
  if (!row) throw new HttpError(404, "NOT_FOUND", "这个固定活动不存在");
  if (db.prepare(`SELECT 1 FROM course_meeting_projections WHERE fixed_event_id = ?`).get(row.id)) {
    throw new HttpError(409, "IS_COURSE", `「${row.title.split(" · ")[0]}」是课程：单次变化说“这次停课/调到哪天”，整门课的变化把新课表发来`);
  }
  if (cmd.expectedVersion !== null && cmd.expectedVersion !== row.version) throw new HttpError(409, "STALE_VERSION", "这个活动刚被改过，请按最新的再说一次");
  if (cmd.skipDate) {
    const wd = ((new Date(`${cmd.skipDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
    const occurs = row.event_date ? row.event_date === cmd.skipDate : wd === row.weekday && (!row.valid_from || row.valid_from <= cmd.skipDate) && (!row.valid_until || cmd.skipDate <= row.valid_until);
    if (!occurs) throw new HttpError(422, "NO_OCCURRENCE", `${md(cmd.skipDate)} 本来就没有「${row.title}」`);
    const ex = db.prepare(`SELECT cancelled FROM fixed_event_exceptions WHERE event_id = ? AND local_date = ?`).get(row.id, cmd.skipDate) as { cancelled: number } | undefined;
    if (ex?.cancelled) return `${md(cmd.skipDate)} 的「${row.title}」已经标为不去了，没有变化`;
    if (ex) throw new HttpError(409, "HAS_EXCEPTION", `${md(cmd.skipDate)} 的「${row.title}」已经单独改过时间：请先在日程里处理那次改动`);
    db.prepare(`INSERT INTO fixed_event_exceptions (event_id, local_date, cancelled, local_start, local_end) VALUES (?, ?, 1, NULL, NULL)`).run(row.id, cmd.skipDate);
    changes.push({ entityKind: "fixed_event_exception", entityId: `${row.id}|${cmd.skipDate}`, action: "create", after: { cancelled: true } });
    bumpPlanningRevision();
    return `${md(cmd.skipDate)} 的「${row.title}」（${row.local_start}–${row.local_end}）这次不去，那段时间空出来了；以后照常`;
  }
  const slot = (r: { weekday: number; local_start: string; local_end: string; event_date: string | null }) => `${r.event_date ? md(r.event_date) : `每${WEEKDAY[r.weekday]}`} ${r.local_start}–${r.local_end}`;
  if (cmd.remove) {
    changes.push({ entityKind: "fixed_event", entityId: row.id, action: "delete", before: { ...row } });
    db.prepare(`DELETE FROM fixed_events WHERE id = ?`).run(row.id);
    bumpPlanningRevision();
    return `「${row.title}」（${slot(row)}）以后不再占用时间`;
  }
  const next = {
    title: cmd.title ?? row.title,
    weekday: cmd.eventDate ? ((new Date(`${cmd.eventDate}T00:00:00Z`).getUTCDay() + 6) % 7) + 1 : (cmd.weekday ?? row.weekday),
    local_start: cmd.localStart ?? row.local_start,
    local_end: cmd.localEnd ?? row.local_end,
    event_date: cmd.eventDate !== undefined ? cmd.eventDate : cmd.weekday !== undefined && cmd.weekday !== row.weekday ? null : row.event_date,
  };
  // 只改了开始钟点：时长不变
  if (cmd.localStart && !cmd.localEnd) {
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const end = toMin(cmd.localStart) + (toMin(row.local_end) - toMin(row.local_start));
    if (end > 24 * 60 - 1) throw new HttpError(422, "VALIDATION", "按原来的时长会跨过午夜：请同时说明结束时间");
    next.local_end = `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
  }
  if (next.local_start >= next.local_end) throw new HttpError(422, "VALIDATION", "结束时间必须晚于开始时间");
  const before = { title: row.title, weekday: row.weekday, localStart: row.local_start, localEnd: row.local_end, eventDate: row.event_date };
  const after = { title: next.title, weekday: next.weekday, localStart: next.local_start, localEnd: next.local_end, eventDate: next.event_date };
  if (JSON.stringify(before) === JSON.stringify(after)) return `「${row.title}」没有变化`;
  db.prepare(`UPDATE fixed_events SET title = ?, weekday = ?, local_start = ?, local_end = ?, event_date = ?, version = version + 1 WHERE id = ?`).run(next.title, next.weekday, next.local_start, next.local_end, next.event_date, row.id);
  changes.push({ entityKind: "fixed_event", entityId: row.id, action: "update", before, after, afterVersion: row.version + 1 });
  bumpPlanningRevision();
  return `「${next.title}」${next.title !== row.title ? `（原名「${row.title}」）` : ""}从 ${slot(row)} 改为 ${slot({ ...next })}`;
}
