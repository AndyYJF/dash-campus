import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { getSetting, updateSetting } from "@/repositories/settings";
import { createJob, leaseValid } from "@/repositories/jobs";
import { createDelivery, getDelivery, markSubmitting } from "@/repositories/deliveries";
import { DIGEST_JOB_TYPE, DIGEST_SETTINGS_KEY, PLAN_MAINTENANCE_JOB_TYPE, digestSettingsSchema, type DigestKind } from "@/contracts/digests";
import type { JobRow } from "@/contracts/jobs";
import { addDays, instanceTimezone, localDateInTz, mondayOf, wallTimeToUtc } from "@/domain/time";
import { nextWeeklyRun } from "@/domain/exploration";
import { listTasks } from "@/repositories/planning";
import { getFocus } from "@/repositories/focus";
import { computeWorkload } from "@/domain/workload";
import { weekFacts } from "./week-facts";
import { getMailTemplateSettings } from "./mail-settings";
import { runMailJob, type Admission } from "@/worker/handlers";
import { getConfig } from "@/config";
import { listPendingInboxDecisions } from "./pending-inbox";

export function getDigestSettings() {
  const entry = getSetting(DIGEST_SETTINGS_KEY);
  return { settings: digestSettingsSchema.parse(entry.value ?? {}), version: entry.version };
}

function nextDaily(now: Date, time: string, timezone: string) {
  const date = localDateInTz(now, timezone), today = wallTimeToUtc(date, time, timezone);
  return (today > now ? today : wallTimeToUtc(addDays(date, 1), time, timezone)).toISOString();
}

/** A local schedule occurrence retains its resolved offset in the dedupe key. */
export function occurrenceKey(at: string, timezone: string) {
  const offset = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "shortOffset" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return `${localDateInTz(new Date(at), timezone)}:${offset}`;
}

function systemFailures() {
  const db = getDb();
  const jobs = db.prepare("SELECT id,type,last_error AS error FROM jobs WHERE status='failed' AND type!='digest' AND updated_at>=? ORDER BY updated_at DESC LIMIT 10").all(new Date(Date.now() - 7 * 86400000).toISOString()) as Array<{ id: string; type: string; error: string }>;
  const deliveries = db.prepare("SELECT id,status,error FROM deliveries WHERE status IN ('failed','unknown') AND (job_id IS NULL OR job_id IN (SELECT id FROM jobs WHERE type!='digest')) AND updated_at>=? ORDER BY updated_at DESC LIMIT 10").all(new Date(Date.now() - 7 * 86400000).toISOString()) as Array<{ id: string; status: string; error: string }>;
  return { jobs, deliveries };
}

/** Missed periods merge into one current occurrence; never replay a backlog of digest mail. */
export function scheduleDigests(now = new Date()) {
  const db = getDb(), cfg = getDigestSettings().settings, tz = instanceTimezone();
  let queued = 0;
  // 每天有限重排（P5）：dedupe 键含本地日期，重复调度/错过都不叠加
  createJob({ type: PLAN_MAINTENANCE_JOB_TYPE, dedupeKey: `plan_maintenance:${localDateInTz(now, tz)}`, runAt: now.toISOString(), payload: { date: localDateInTz(now, tz) } });
  for (const kind of ["daily", "weekly"] as const) {
    const enabled = kind === "daily" ? cfg.dailyEnabled : cfg.weeklyEnabled;
    const signature = JSON.stringify(kind === "daily" ? [enabled, cfg.dailyTime, tz] : [enabled, cfg.weeklyWeekday, cfg.weeklyTime, tz]);
    const key = `digestSchedule:${kind}`, entry = getSetting(key), state = entry.value as { signature: string; nextRunAt: string } | null;
    const nextRunAt = kind === "daily" ? nextDaily(now, cfg.dailyTime, tz) : nextWeeklyRun(now, cfg.weeklyWeekday, cfg.weeklyTime, tz);
    db.transaction(() => {
      if (!enabled || !state || state.signature !== signature) { if (!state || state.signature !== signature) updateSetting(key, { signature, nextRunAt }, entry.version); return; }
      if (state.nextRunAt > now.toISOString()) return;
      if (updateSetting(key, { signature, nextRunAt }, entry.version) === "conflict") return;
      createJob({ type: DIGEST_JOB_TYPE, dedupeKey: `digest:${kind}:${occurrenceKey(now.toISOString(), tz)}`, runAt: now.toISOString(), payload: { kind, date: localDateInTz(now, tz) } }); queued++;
    }).immediate();
  }
  if (cfg.systemEnabled) {
    const failures = systemFailures();
    if (failures.jobs.length + failures.deliveries.length) {
      const fingerprint = crypto.createHash("sha256").update(JSON.stringify([failures.jobs.map((j) => j.id).sort(), failures.deliveries.map((d) => `${d.id}:${d.status}`).sort()])).digest("hex");
      const key = "digestSystemFingerprint", entry = getSetting(key);
      if (entry.value !== fingerprint) db.transaction(() => {
        if (updateSetting(key, fingerprint, entry.version) === "conflict") return;
        createJob({ type: DIGEST_JOB_TYPE, dedupeKey: `digest:system:${fingerprint}`, runAt: now.toISOString(), payload: { kind: "system", date: localDateInTz(now, tz) } }); queued++;
      }).immediate();
    }
  }
  return queued;
}

function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)); }

/** Facts only. Exploration notifications are merged here, rather than sent per search result. */
export function renderDigest(kind: DigestKind, date: string) {
  const db = getDb(), tz = instanceTimezone(), settings = getMailTemplateSettings(), monday = mondayOf(date), lines: string[] = [];
  const taskStatus = {todo:"待办",doing:"进行中",blocked:"受阻",done:"已完成",cancelled:"已取消"};
  const label = { daily: "今日摘要", weekly: "每周回顾", system: "系统异常" }[kind];
  if (kind === "daily") {
    const focus = getFocus(monday, tz); if (focus) lines.push(settings.privacyMode ? "本周已设置重点（隐私模式隐藏正文）" : `本周重点：${focus.title}`);
    const tasks = listTasks().filter((t) => !["done", "cancelled"].includes(t.status) && (t.plannedWeek?.localMonday === monday || (t.due.kind === "date" && t.due.localDate <= date) || (t.scheduledStart && localDateInTz(new Date(t.scheduledStart), tz) <= date)));
    lines.push(`本周及已到期任务：${tasks.length} 项`);
    for (const t of tasks.slice(0, 12)) lines.push(settings.privacyMode ? `任务 · ${taskStatus[t.status]}` : `${t.title} · ${taskStatus[t.status]} · ${t.estimateMinutes === null ? "估时未知" : `${t.estimateMinutes} 分钟`}`);
    const workload = computeWorkload(listTasks(), monday, new Date());
    lines.push(`剩余已知工作量 ${workload.remainingKnownMinutes} 分钟，${workload.remainingUnknownCount} 项估时未知；未来容量 ${workload.futureCapacityMinutes ?? "未知"} 分钟`);
  } else if (kind === "weekly") {
    const f = weekFacts(addDays(monday, -7), tz);
    lines.push(`回顾 ${f.localMonday} 起的一周：完成 ${f.completedTasks.length} 项任务，${f.logs.length} 条记录，${f.artifacts.length} 项成果。`);
    for (const l of f.logs.slice(0, 5)) if (!settings.privacyMode) lines.push(`${l.occurredOn}：${l.progress || "未填写进展"}${l.blocker ? `；卡点：${l.blocker}` : ""}`);
    const review = db.prepare("SELECT status FROM reviews WHERE local_monday=? AND timezone=? ORDER BY created_at DESC LIMIT 1").get(f.localMonday, tz) as { status: string } | undefined;
    lines.push(review ? `周复盘状态：${review.status}，请进入回顾页查看依据与提案。` : "尚未生成周复盘，可在回顾页手动生成；未调用模型编造总结。");
    if (f.practice.count) lines.push(`实践记录 ${f.practice.count} 次，共 ${f.practice.totalMinutes} 分钟。`);
    lines.push(`学习块：计划 ${f.planSessions.planned} 个，完成 ${f.planSessions.completed}，跳过 ${f.planSessions.skipped}。`);
  } else {
    const failures = systemFailures();
    lines.push(`最近异常：${failures.jobs.length} 个后台任务、${failures.deliveries.length} 封投递。`);
    for (const j of failures.jobs) lines.push(settings.privacyMode ? `后台任务失败：${j.type}` : `${j.type}：${j.error.slice(0, 300)}`);
    for (const d of failures.deliveries) lines.push(`投递 ${d.status}${settings.privacyMode ? "" : `：${(d.error ?? "").slice(0, 300)}`}`);
    lines.push("结果未确定的邮件不会自动重发，请在设置中核对。");
  }
  if (kind !== "system") {
    const since = new Date(Date.now() - (kind === "weekly" ? 7 : 1) * 86400000).toISOString();
    const runs = db.prepare("SELECT id,status FROM exploration_runs WHERE created_at>=? ORDER BY created_at DESC LIMIT 10").all(since) as Array<{ id: string; status: string }>;
    if (runs.length) {
      const ids = runs.map((r) => r.id), candidates = db.prepare(`SELECT COUNT(*) AS n FROM candidates WHERE run_id IN (${ids.map(() => "?").join(",")})`).get(...ids) as { n: number };
      lines.push(`探索汇总：${runs.length} 次探索，${candidates.n} 个候选；进入探索页比较资料、未知条件与下一步。`);
    }
    lines.push(`通知待处理：${listPendingInboxDecisions().length} 条。`);
  }
  const base = getConfig().APP_BASE_URL.replace(/\/$/, ""), link = `${base}/${kind === "weekly" ? "reviews" : kind === "system" ? "settings" : "today"}`;
  const text = `${label} · ${date}\n\n${lines.join("\n").slice(0, settings.summaryMaxLength * 4)}\n\n打开工作台：${link}`;
  return { subject: `${settings.subjectPrefix} ${label} · ${date}`, text, html: `<main style="font-family:system-ui;max-width:640px;margin:auto"><h1 style="color:${settings.themeColor}">${escapeHtml(label)}</h1><p>${escapeHtml(date)}</p><div style="white-space:pre-wrap">${escapeHtml(lines.join("\n").slice(0, settings.summaryMaxLength * 4))}</div><p><a href="${escapeHtml(link)}">打开工作台</a></p></main>` };
}

export async function runDigestJob(job: JobRow) {
  return runMailJob(job, (j, now): Admission => getDb().transaction((): Admission => {
    if (!leaseValid(j.id, j.leaseToken!, j.generation, now)) return { kind: "skip", reason: "lease_lost" };
    const { kind, date } = j.payload as { kind: DigestKind; date: string }, cfg = getDigestSettings().settings;
    if (!(kind === "daily" ? cfg.dailyEnabled : kind === "weekly" ? cfg.weeklyEnabled : cfg.systemEnabled)) return { kind: "skip", reason: "digest_disabled" };
    if (date < localDateInTz(new Date(now), instanceTimezone())) return { kind: "skip", reason: "digest_expired" };
    const email = renderDigest(kind, date), delivery = createDelivery({ jobId: j.id, taskId: null, leaseToken: j.leaseToken, reminderRevision: 0, recipient: getConfig().MAIL_TO ?? "", subject: email.subject, snapshot: { ...email, taskId: null, taskTitle: "", dueLabel: "", generatedAt: now, kind } });
    markSubmitting(delivery.id); return { kind: "delivery", delivery: getDelivery(delivery.id)! };
  }).immediate());
}
