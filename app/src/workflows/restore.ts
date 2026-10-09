import type Database from "better-sqlite3";
import { getDb } from "@/repositories/db";
import { getInstanceState } from "@/repositories/instance";
import { listTasks } from "@/repositories/planning";
import { refreshReminders } from "@/workflows/reminders";
import { reminderTriggerUtc } from "@/domain/reminders";
import { localDateInTz, instanceTimezone } from "@/domain/time";
import { nextWeeklyRun } from "@/domain/exploration";

/**
 * 恢复与恢复后启用（计划 10.2 / F14）。
 * - applyRestoreHold：restore 命令在任何进程启动前对恢复出来的库执行。写入持久 restored_hold、
 *   deploymentEpoch+1；旧 job 租约一律失效；submitting/unknown 统一为 unknown；其余待执行旧 job 标记 restored_pending。
 * - resumeAfterRestore：主人显式确认旧实例已停止后执行。取消恢复出来的历史 job，
 *   只按当前任务重建触发时间晚于"现在"的提醒；周期任务从下一个周期开始，不补跑恢复缺口。
 * 任何一步都不从旧备份推断备份后邮件是否已送达，也不自动补发。
 */

export type HoldSummary = {
  heldJobs: number;
  unknownDeliveries: number;
  deploymentEpoch: number;
};

export function applyRestoreHold(db: Database.Database, restoredFrom: string, nowIso = new Date().toISOString()): HoldSummary {
  return db.transaction((): HoldSummary => {
    db.prepare(
      `UPDATE instance_state SET restored_hold = 1, deployment_epoch = deployment_epoch + 1,
         restored_at = ?, restored_from = ?, resumed_at = NULL, worker_heartbeat_at = NULL WHERE id = 1`,
    ).run(nowIso, restoredFrom);
    // 旧租约失效：清 token、generation+1；未结束的 job 统一挂起为 restored_pending，状态回到 queued 但不可领取
    const held = db
      .prepare(
        `UPDATE jobs SET status = 'queued', lease_token = NULL, lease_until = NULL, generation = generation + 1,
           hold_state = 'restored_pending', updated_at = ?
         WHERE status IN ('queued', 'running')`,
      )
      .run(nowIso).changes;
    // 备份时"提交中"的投递：结果不可知（可能已发），与 unknown 同样处理，不自动重发
    db.prepare(
      `UPDATE deliveries SET status = 'unknown', error = COALESCE(error, '从备份恢复：发送结果不确定，可能已发送'), updated_at = ?
       WHERE status = 'submitting'`,
    ).run(nowIso);
    const totalUnknown = (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'unknown'`).get() as { n: number }).n;
    const epoch = (db.prepare(`SELECT deployment_epoch AS e FROM instance_state WHERE id = 1`).get() as { e: number }).e;
    return { heldJobs: held, unknownDeliveries: totalUnknown, deploymentEpoch: epoch };
  })();
}

export type RestoreStatus = {
  hold: boolean;
  restoredAt: string | null;
  restoredFrom: string | null;
  resumedAt: string | null;
  deploymentEpoch: number;
  heldJobs: Array<{ id: string; type: string; runAt: string; taskId: string | null }>;
  /** 触发点已过的提醒：只显示待处理摘要，不自动补发 */
  pastReminders: Array<{ taskId: string; title: string; triggerAt: string }>;
  unknownDeliveries: number;
};

export function restoreStatus(nowIso = new Date().toISOString()): RestoreStatus {
  const db = getDb();
  const st = getInstanceState();
  const heldJobs = (
    db
      .prepare(`SELECT id, type, run_at, task_id FROM jobs WHERE hold_state = 'restored_pending' ORDER BY run_at LIMIT 200`)
      .all() as Array<{ id: string; type: string; run_at: string; task_id: string | null }>
  ).map((j) => ({ id: j.id, type: j.type, runAt: j.run_at, taskId: j.task_id }));
  const pastReminders: RestoreStatus["pastReminders"] = [];
  if (st.restoredHold) {
    for (const t of listTasks()) {
      if (t.archivedAt || t.status === "done" || t.status === "cancelled") continue;
      const trigger = reminderTriggerUtc(t.due, t.reminderLeadMinutes);
      if (trigger && trigger <= nowIso) pastReminders.push({ taskId: t.id, title: t.title, triggerAt: trigger });
    }
  }
  const unknownDeliveries = (db.prepare(`SELECT COUNT(*) AS n FROM deliveries WHERE status = 'unknown'`).get() as { n: number }).n;
  return {
    hold: st.restoredHold,
    restoredAt: st.restoredAt,
    restoredFrom: st.restoredFrom,
    resumedAt: st.resumedAt,
    deploymentEpoch: st.deploymentEpoch,
    heldJobs,
    pastReminders,
    unknownDeliveries,
  };
}

export type ResumeResult =
  | { ok: false; reason: "not_on_hold" }
  | {
      ok: true;
      cancelledJobs: number;
      cancelledDeliveries: number;
      rebuiltReminders: number;
      skippedPastReminders: number;
      topicsRescheduled: number;
      /** 恢复前没处理完、现已停止的投递数 */
      stoppedIntakes: number;
    };

/** 显式确认后解除 hold（resume-after-restore）。同一事务内完成，任何一步失败整体回滚、hold 保持。 */
export function resumeAfterRestore(now = new Date()): ResumeResult {
  const db = getDb();
  const nowIso = now.toISOString();
  return db.transaction((): ResumeResult => {
    const st = getInstanceState();
    if (!st.restoredHold) return { ok: false, reason: "not_on_hold" };

    // 1. 取消恢复出来的历史 job；dedupe_key 加上 epoch 后缀，释放给按当前任务重建的新提醒
    const cancelledJobs = db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', hold_state = NULL, cancel_requested = 1,
           dedupe_key = dedupe_key || ':restored-e' || ?, last_error = '从备份恢复后取消', updated_at = ?
         WHERE hold_state = 'restored_pending'`,
      )
      .run(st.deploymentEpoch, nowIso).changes;
    const cancelledDeliveries = db
      .prepare(`UPDATE deliveries SET status = 'cancelled', error = '从备份恢复后取消', updated_at = ? WHERE status = 'queued'`)
      .run(nowIso).changes;
    // 挂起的 AI 工作流对象随 job 一起结束，页面不再显示"排队中"
    db.prepare(
      `UPDATE exploration_runs SET status = 'cancelled', error_code = 'RESTORED', error_message = '从备份恢复后取消，可重新发起',
         finished_at = ?, updated_at = ? WHERE status NOT IN ('done', 'failed', 'cancelled')`,
    ).run(nowIso, nowIso);
    db.prepare(
      `UPDATE reviews SET status = 'cancelled', error_code = 'RESTORED', error_message = '从备份恢复后取消，可重新生成', updated_at = ?
       WHERE status IN ('queued', 'generating')`,
    ).run(nowIso);

    db.prepare("UPDATE notice_extractions SET status='failed',error='RESTORED：从备份恢复后取消，可在详情重新提取',updated_at=? WHERE status IN ('queued','running')").run(nowIso);
    db.prepare(
      `UPDATE assistant_requests SET status = 'cancelled', error_code = 'RESTORED', error_message = '从备份恢复后取消，可重新分析', updated_at = ?
       WHERE status IN ('queued', 'running')`,
    ).run(nowIso);

    db.prepare("UPDATE ai_news_runs SET status='cancelled',error_message='从备份恢复后取消，可重新更新',updated_at=? WHERE status IN ('queued','running')").run(nowIso);
    db.prepare("INSERT INTO settings(key,value_json,version,updated_at) VALUES('aiNewsScheduleDate',?,1,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=settings.version+1,updated_at=excluded.updated_at").run(JSON.stringify(localDateInTz(now, instanceTimezone())),nowIso);

    // 恢复之前还没处理完的投递：它们的后台任务已取消，epoch 也已过期，不会再执行。
    // 没执行的事项和挂着的问题一并收掉并写明原因；已经生效的部分保留、仍可撤销。原件都还在，需要就重新发一次。
    const staleIntakes = db.prepare(`SELECT id FROM intakes WHERE status IN ('received','processing','waiting_input') AND instance_epoch != ?`).all(st.deploymentEpoch) as Array<{ id: string }>;
    for (const { id } of staleIntakes) {
      db.prepare(
        `UPDATE intake_items SET state = 'cancelled', waiting_question_id = NULL, evidence_json = json_set(COALESCE(evidence_json, '{}'), '$.note', '从备份恢复后停止处理：需要的话请重新发一次'), updated_at = ?
         WHERE intake_id = ? AND state IN ('extracted','resolving','awaiting_input','ready')`,
      ).run(nowIso, id);
      db.prepare(`UPDATE clarification_questions SET status = 'superseded', version = version + 1, updated_at = ? WHERE intake_id = ? AND status = 'open'`).run(nowIso, id);
      const applied = db.prepare(`SELECT 1 FROM intake_items WHERE intake_id = ? AND state = 'applied'`).get(id);
      db.prepare(`UPDATE intakes SET status = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(applied ? "partially_applied" : "cancelled", nowIso, id);
    }

    // 2. 按当前任务重建未来提醒：refreshReminders 只建触发时间晚于 now 的 job；过去的只进"今日待处理"
    let rebuiltReminders = 0;
    let skippedPastReminders = 0;
    for (const t of listTasks()) {
      if (t.archivedAt || t.status === "done" || t.status === "cancelled") continue;
      const trigger = reminderTriggerUtc(t.due, t.reminderLeadMinutes);
      if (!trigger) continue;
      if (trigger <= nowIso) {
        skippedPastReminders++;
        continue;
      }
      // hold 期间主人改过的任务已按新 revision 建了 job：保留，不再重复取消重建
      const existing = db
        .prepare(`SELECT status FROM jobs WHERE dedupe_key = ?`)
        .get(`reminder:${t.id}:${t.reminderRevision}`) as { status: string } | undefined;
      if (!existing || existing.status !== "queued") refreshReminders(t, nowIso);
      rebuiltReminders++;
    }

    // 3. 周期任务从下一个周期开始，不补跑恢复缺口
    const topics = db
      .prepare(`SELECT id, weekday, local_time, timezone FROM exploration_topics WHERE enabled = 1 AND archived_at IS NULL`)
      .all() as Array<{ id: string; weekday: number; local_time: string; timezone: string }>;
    for (const tp of topics) {
      db.prepare(`UPDATE exploration_topics SET next_run_at = ?, updated_at = ? WHERE id = ?`).run(
        nextWeeklyRun(now, tp.weekday, tp.local_time, tp.timezone),
        nowIso,
        tp.id,
      );
    }
    // 定期周复盘：删掉调度状态，worker 下一趟按"现在之后"重新计算（configChanged 分支不入队）
    db.prepare(`DELETE FROM settings WHERE key = 'weeklyReviewNextRun'`).run();
    db.prepare("DELETE FROM settings WHERE key IN ('digestSchedule:daily','digestSchedule:weekly')").run();

    db.prepare(`UPDATE instance_state SET restored_hold = 0, resumed_at = ? WHERE id = 1`).run(nowIso);
    return { ok: true, cancelledJobs, cancelledDeliveries, rebuiltReminders, skippedPastReminders, topicsRescheduled: topics.length, stoppedIntakes: staleIntakes.length };
  })();
}

export { RESTORED_HOLD_MESSAGE } from "@/repositories/instance";
