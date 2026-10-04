import { getDb } from "@/repositories/db";
import { OPERATIONS, type Command } from "@/contracts/commands";
import { getBatch, listChanges } from "@/repositories/journal";
import type { FollowUp, OperationOutcome } from "@/workflows/commands";
import { snapshotRevision } from "@/workflows/snapshot";
import { instanceTimezone, localDateInTz } from "@/domain/time";
import { nowDate } from "@/domain/clock";
import { estimateAdvice, type EstimateSample } from "@/domain/estimate-advice";
import { getIntake, listItems, type IntakeRow } from "@/repositories/intakes";
import { listQuestionsForIntake } from "@/repositories/questions";
import { getGoal } from "@/repositories/goals";

/**
 * 统一业务结果（AGENT-INTERFACE-CONTRACT §5.3）：聊天、卡片按钮、兼容 API 的结果同一形状。
 * 实际变更、后续状态（安排是否已更新）、撤销入口分开给出；主界面不暴露 job/epoch/JSON 等实现词。
 */

export type ChangeView = { entity: { kind: string; id: string }; label: string; action: "create" | "update" | "delete"; detail: string };

export type OperationResultView = {
  operation: string;
  title: string;
  state: "applied" | "no_change" | "failed";
  summary: string;
  changes: ChangeView[];
  affectedDates: string[];
  followUps: Array<{ kind: string; state: string; summary: string }>;
  undo: { available: boolean; batchId: string | null; note: string };
  snapshotRevision: string;
  error: { code: string; message: string; recoverable: boolean } | null;
};

const KIND_LABEL: Record<string, string> = {
  task: "任务",
  plan_session: "学习安排",
  practice_entry: "实践记录",
  course_set: "课表",
  course: "课程",
  fixed_event: "固定活动",
  course_exception: "停课例外",
  teaching_override: "调课/停课",
  holiday_dataset: "节假日安排",
  academic_calendar: "校历",
  policy_rule: "时间规则",
  planning_preferences: "作息",
  goal: "目标",
  project: "项目",
  semester: "学期",
  setting: "设置",
  profile_fact: "身份信息",
  profile_rule: "筛选规则",
};

const RECOVERABLE = new Set(["STALE_VERSION", "NO_SLOT", "OVER_BUDGET", "DEADLINE_CONFLICT", "SLOT_CONFLICT", "AMBIGUOUS_REFERENCE", "ANCHOR_CONFLICT", "MAPPING_CONFLICT", "UNDO_CONFLICT", "CONFLICT"]);

/** 失败码 → HTTP 状态（兼容适配层用） */
export function statusForCode(code: string): number {
  if (code === "NOT_FOUND") return 404;
  if (code === "NOT_AUTHORIZED" || code === "STALE_EPOCH") return 403;
  if (code === "VALIDATION" || code === "UNKNOWN_OPERATION" || code === "INVALID_REFERENCE" || code === "IN_THE_PAST" || code === "NO_OFFICIAL_SOURCE") return 422;
  return 409;
}

export function entityLabel(kind: string, id: string): string {
  const db = getDb();
  if (kind === "task") return (db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? "任务";
  if (kind === "plan_session") {
    const r = db.prepare(`SELECT t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`).get(id) as { title: string } | undefined;
    return r ? `${r.title} 的学习安排` : "学习安排";
  }
  if (kind === "course") return (db.prepare(`SELECT name FROM courses WHERE id = ?`).get(id) as { name: string } | undefined)?.name ?? "课程";
  if (kind === "goal") return (db.prepare(`SELECT title FROM goals WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? "目标";
  if (kind === "project") return (db.prepare(`SELECT title FROM projects WHERE id = ?`).get(id) as { title: string } | undefined)?.title ?? "项目";
  return KIND_LABEL[kind] ?? kind;
}

/** 一个批次的变更列表（同类大量变更合并成一行，如课表的几十条规则） */
export function batchChanges(batchId: string): { changes: ChangeView[]; dates: string[] } {
  const tz = instanceTimezone();
  const rows = listChanges(batchId);
  const dates = new Set<string>();
  const counts = new Map<string, number>();
  const views: ChangeView[] = [];
  for (const c of rows) {
    for (const v of [c.before, c.after]) {
      for (const key of ["startUtc", "start"]) {
        const raw = v?.[key];
        if (typeof raw === "string" || typeof raw === "number") dates.add(localDateInTz(new Date(raw), tz));
      }
      for (const key of ["sourceTeachingDate", "targetDate", "occurredOn", "dateFrom", "dateTo", "eventDate"]) {
        if (typeof v?.[key] === "string") dates.add(v[key] as string);
      }
    }
    const bulky = ["course", "course_meeting", "projection", "fixed_event", "holiday_day", "academic_calendar_event"].includes(c.entityKind);
    if (bulky) {
      const key = `${c.entityKind}:${c.action}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      continue;
    }
    const verb = c.action === "create" ? "新增" : c.action === "delete" ? "移除" : "修改";
    views.push({ entity: { kind: c.entityKind, id: c.entityId }, label: entityLabel(c.entityKind, c.entityId), action: c.action, detail: `${verb}${KIND_LABEL[c.entityKind] ?? ""}` });
  }
  const bulkLabel: Record<string, string> = { course: "门课程", course_meeting: "个上课时段", projection: "条课程规则", fixed_event: "条日程规则", holiday_day: "个日期", academic_calendar_event: "个校历事项" };
  for (const [key, n] of counts) {
    const [kind, action] = key.split(":") as [string, ChangeView["action"]];
    if (kind === "projection" || kind === "course_meeting") continue; // 实现细节，不单独展示
    views.push({ entity: { kind, id: "" }, label: `${n} ${bulkLabel[kind] ?? kind}`, action, detail: action === "create" ? "新增" : action === "delete" ? "移除" : "修改" });
  }
  return { changes: views.slice(0, 20), dates: [...dates].sort() };
}

export function followUpView(f: FollowUp): { kind: string; state: string; summary: string } {
  if (f.state === "failed") return { kind: f.kind, state: "failed", summary: `学习安排没有更新成功：${f.error ?? ""}` };
  const parts: string[] = [];
  if (f.placed) parts.push(`新排 ${f.placed} 段`);
  if (f.superseded) parts.push(`替换 ${f.superseded} 段`);
  if (f.unscheduled.length) parts.push(`${f.unscheduled.length} 项排不下`);
  if (f.conflicts.length) parts.push(`${f.conflicts.length} 段近期安排有冲突，等你决定`);
  return { kind: f.kind, state: f.state, summary: parts.length ? `学习安排已更新：${parts.join("，")}` : "学习安排不需要变化" };
}

export function undoView(batchId: string | null, operation: string): OperationResultView["undo"] {
  if (!batchId) return { available: false, batchId: null, note: "" };
  const meta = OPERATIONS[operation as Command["command"]];
  const batch = getBatch(batchId);
  if (!batch || batch.status === "undone") return { available: false, batchId, note: batch ? "已撤销" : "" };
  if (meta && meta.undo === "none") return { available: false, batchId, note: "这个操作不能撤销" };
  return { available: true, batchId, note: "" };
}

export function operationResultView(operation: string, outcome: OperationOutcome): OperationResultView {
  const title = OPERATIONS[operation as Command["command"]]?.title ?? operation;
  const r = outcome.result;
  if (!r.ok) {
    return { operation, title, state: "failed", summary: r.error, changes: [], affectedDates: [], followUps: [], undo: { available: false, batchId: null, note: "" }, snapshotRevision: snapshotRevision(), error: { code: r.code, message: r.error, recoverable: RECOVERABLE.has(r.code) } };
  }
  const detail = r.batchId && operation !== "undo_batch" ? batchChanges(r.batchId) : { changes: [], dates: [] };
  return {
    operation,
    title,
    state: r.noChange ? "no_change" : "applied",
    summary: r.summary,
    changes: detail.changes,
    affectedDates: detail.dates,
    followUps: outcome.followUps.map(followUpView),
    undo: operation === "undo_batch" ? { available: false, batchId: r.batchId, note: "" } : undoView(r.batchId, operation),
    snapshotRevision: snapshotRevision(),
    error: null,
  };
}

// ===== 一份投递的统一结果 =====

export type IntakeResultView = {
  intakeId: string;
  conversationId: string | null;
  createdAt: string;
  text: string;
  /** accepted 已收到 / working 处理中 / needs_input 等你回答 / applied 已更新 / partly_applied 部分完成 / no_change 只存了资料 / failed / cancelled */
  state: "accepted" | "working" | "needs_input" | "applied" | "partly_applied" | "no_change" | "answered" | "failed" | "cancelled";
  summary: string;
  links: Array<{ label: string; href: string }>;
  items: Array<{ id: string; kind: string; state: string; summary: string; error: string | null; routedBy: string | null; rationale: string | null; sources: string[] }>;
  /** 理解方式：model=模型路由（含只读查询依据）、fast=确定性快路径、rules=模型不可用或失败后按规则；fallbackReason 说明为什么降级 */
  understanding: { routedBy: "model" | "fast" | "rules" | null; fallbackReason: string | null; sources: string[] };
  changes: ChangeView[];
  questions: Array<{ id: string; prompt: string; reason: string; options: string[]; purpose: string; version: number }>;
  nextActions: string[];
  affectedDates: string[];
  followUps: Array<{ kind: string; state: string; summary: string }>;
  undo: { available: boolean; batchIds: string[]; note: string };
  snapshotRevision: string;
  error: { message: string; recoverable: boolean } | null;
  /** 所属目标：current=false 表示目标已被改口/停止，这一轮的结果不再是最新 */
  goal: { id: string; revision: number; intakeRevision: number; current: boolean; state: string; objective: string } | null;
};

const REASON_TEXT: Record<string, string> = {
  deadline_unfeasible: "截止前排不下",
  insufficient_capacity: "这周的学习预算不够",
  unknown_requirement: "工作量还不清楚",
  no_contiguous_slot: "预算够，但缺连续空档",
  needs_remaining_estimate: "需要你说一下还差多少",
};

function timeLabel(utc: string, tz: string): string {
  const d = localDateInTz(new Date(utc), tz);
  const t = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(utc));
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${t}`;
}

export function intakeResultView(intake: IntakeRow): IntakeResultView {
  const db = getDb();
  const tz = instanceTimezone();
  const items = listItems(intake.id);
  const batches = db.prepare(`SELECT id, command, status, reason FROM agent_action_batches WHERE intake_id = ? ORDER BY created_at, rowid`).all(intake.id) as Array<{ id: string; command: string; status: string; reason: string }>;
  const commandBatches = batches.filter((b) => b.command !== "plan_sessions");
  const planBatches = batches.filter((b) => b.command === "plan_sessions");
  const applied = commandBatches.filter((b) => b.status === "applied");

  const changes: ChangeView[] = [];
  const dates = new Set<string>();
  for (const b of applied) {
    const detail = batchChanges(b.id);
    changes.push(...detail.changes);
    for (const d of detail.dates) dates.add(d);
  }

  // 触及的任务 → 下一步（最近的学习块）或具体阻碍
  const taskIds = new Set<string>();
  for (const b of [...applied, ...planBatches.filter((p) => p.status === "applied")]) {
    for (const c of listChanges(b.id)) {
      if (c.entityKind === "task") taskIds.add(c.entityId);
      if (c.entityKind === "plan_session") {
        const t = db.prepare(`SELECT task_id FROM plan_sessions WHERE id = ?`).get(c.entityId) as { task_id: string } | undefined;
        if (t) taskIds.add(t.task_id);
      }
    }
  }
  const nextActions: string[] = [];
  const nowIso = nowDate().toISOString();
  const latestPlan = planBatches[planBatches.length - 1];
  let unscheduled: Array<{ taskId: string; title: string; reason: string; missingMinutes?: number }> = [];
  try {
    unscheduled = latestPlan ? ((JSON.parse(latestPlan.reason) as { unscheduled?: typeof unscheduled }).unscheduled ?? []) : [];
  } catch {
    unscheduled = [];
  }
  for (const taskId of taskIds) {
    const task = db.prepare(`SELECT title, status FROM tasks WHERE id = ? AND archived_at IS NULL`).get(taskId) as { title: string; status: string } | undefined;
    if (!task || task.status === "done" || task.status === "cancelled") continue;
    const next = db.prepare(`SELECT start_utc, end_utc FROM plan_sessions WHERE task_id = ? AND status IN ('planned','tentative','in_progress') AND end_utc > ? ORDER BY start_utc LIMIT 1`).get(taskId, nowIso) as { start_utc: string; end_utc: string } | undefined;
    if (next) {
      nextActions.push(`${timeLabel(next.start_utc, tz)}–${timeLabel(next.end_utc, tz).slice(-5)} ${task.title}`);
      dates.add(localDateInTz(new Date(next.start_utc), tz));
    }
    const blocked = unscheduled.find((u) => u.taskId === taskId);
    if (blocked) nextActions.push(`「${task.title}」${REASON_TEXT[blocked.reason] ?? blocked.reason}${blocked.missingMinutes ? `（缺 ${blocked.missingMinutes} 分钟）` : ""}`);
  }

  // 估时建议：同项目（没有项目就同为无项目的任务）里至少 3 个已完成且有实际用时的样本才给；不改主人的估时
  for (const taskId of taskIds) {
    const t = db.prepare(`SELECT title, estimate_minutes, project_id, status FROM tasks WHERE id = ?`).get(taskId) as { title: string; estimate_minutes: number | null; project_id: string | null; status: string } | undefined;
    if (!t || !t.estimate_minutes || t.status === "done") continue;
    const samples = db
      .prepare(
        `SELECT t.estimate_minutes AS estimateMinutes, SUM(p.actual_minutes) AS actualMinutes FROM tasks t JOIN practice_entries p ON p.task_id = t.id
         WHERE t.status = 'done' AND t.id != ? AND t.estimate_minutes > 0 AND p.actual_minutes IS NOT NULL AND p.category = 'study' AND t.project_id IS ? GROUP BY t.id`,
      )
      .all(taskId, t.project_id) as EstimateSample[];
    const advice = estimateAdvice(t.estimate_minutes, samples);
    if (advice) nextActions.push(`「${t.title}」你估 ${t.estimate_minutes} 分钟；最近 ${advice.samples} 个同类任务实际用时约为估时的 ${advice.ratio} 倍，可能要 ${advice.suggestedMinutes} 分钟左右（只是参考，没有改你的估时）`);
  }

  // 没读清/待核对的具体位置：如实列出，不当成已完成
  for (const i of items) {
    const unclear = (i.payload.unclear as string[] | undefined) ?? [];
    if (unclear.length && i.state !== "failed") nextActions.push(`有 ${unclear.length} 处没读清，没有据此生成内容：${unclear.slice(0, 3).join("；")}`);
    for (const d of (i.payload.unresolvedTargets as string[] | undefined) ?? []) nextActions.push(`${d} 按哪天的课上还不清楚，已标为待核对`);
    const note = i.evidence?.note as string | undefined;
    if (note && i.state === "ignored") nextActions.push(note);
  }

  const followUps: IntakeResultView["followUps"] = [];
  for (const i of items) for (const f of (i.payload.followUps as IntakeResultView["followUps"] | undefined) ?? []) if (!followUps.some((x) => x.summary === f.summary)) followUps.push(f);

  const questions = listQuestionsForIntake(intake.id)
    .filter((q) => q.status === "open")
    .map((q) => ({ id: q.id, prompt: q.prompt, reason: q.reason, options: q.options ?? [], purpose: q.purpose, version: q.version }));

  const itemViews = items.map((i) => ({
    id: i.id,
    kind: i.kind,
    state: i.state,
    summary: ((i.payload.applied as { summary?: string } | undefined)?.summary ?? (i.payload.summary as string | undefined) ?? "").slice(0, 300),
    error: (i.evidence?.error as string | undefined) ?? null,
    routedBy: (i.payload.routedBy as string | undefined) ?? null,
    rationale: typeof i.payload.decisionRationale === "string" ? i.payload.decisionRationale.slice(0, 300) : null,
    sources: ((i.payload.observations as Array<{ label: string }> | undefined) ?? []).map((o) => o.label).slice(0, 8),
  }));
  const routeDoc = db.prepare(`SELECT content_text FROM extracted_documents WHERE intake_id = ? AND source_kind = 'owner-route' ORDER BY created_at DESC LIMIT 1`).get(intake.id) as { content_text: string } | undefined;
  let routeInfo: { routedBy?: "model" | "rules"; fallbackReason?: string; observations?: Array<{ label: string }> } = {};
  try {
    routeInfo = routeDoc ? JSON.parse(routeDoc.content_text) : {};
  } catch {
    routeInfo = {};
  }
  const understanding: IntakeResultView["understanding"] = {
    routedBy: routeInfo.routedBy ?? (items.some((i) => i.payload.routedBy === "fast") ? "fast" : null),
    fallbackReason: routeInfo.routedBy === "rules" ? (routeInfo.fallbackReason ?? null)?.slice(0, 300) ?? null : null,
    sources: [...new Set((routeInfo.observations ?? []).map((o) => o.label))].slice(0, 8),
  };
  const failed = itemViews.filter((i) => i.state === "failed");
  const visibleItems = items.filter((i) => i.state !== "cancelled");
  const readOnly = visibleItems.length > 0 && visibleItems.every((i) => i.state === "applied" && i.payload.readOnly === true) && batches.every((b) => b.status === "undone");
  const state: IntakeResultView["state"] =
    intake.status === "received"
      ? "accepted"
      : intake.status === "processing"
        ? "working"
        : intake.status === "waiting_input"
          ? "needs_input"
          : intake.status === "cancelled"
            ? "cancelled"
            : intake.status === "failed"
              ? "failed"
              : intake.status === "partially_applied"
                ? "partly_applied"
                : readOnly
                  ? "answered"
                  : applied.length || items.some((i) => i.state === "applied" && (i.payload.applied as { noChange?: boolean } | undefined)?.noChange === false)
                  ? "applied"
                  : "no_change";
  const done = items.filter((i) => i.state === "applied").map((i) => (i.payload.applied as { summary?: string } | undefined)?.summary).filter((x): x is string => Boolean(x));
  const saved = items.filter((i) => i.state === "ready" && (i.kind === "note" || i.kind === "notice"));
  const goal = goalView(intake);
  const superseded = goal && !goal.current ? [`这个目标已按你后来的要求改为第 ${goal.revision} 版${goal.state === "cancelled" ? "（已停止）" : ""}，这一轮还没执行的部分已作废`] : [];
  const summary =
    state === "accepted" || state === "working"
      ? "已收到，正在整理"
      : [...done, ...(saved.length ? [`已存为资料 ${saved.length} 条（没有需要你行动的事项）`] : []), ...failed.map((f) => `没有办成：${f.error ?? "处理失败"}`), ...superseded].join("；") || (state === "needs_input" ? "需要你回答一个问题才能继续" : "已处理");
  const undoable = applied.filter((b) => OPERATIONS[b.command as Command["command"]]?.undo !== "none").map((b) => b.id);
  const correctedRead = items.some((i) => i.payload.readCorrection === true);
  return {
    intakeId: intake.id,
    conversationId: intake.conversationId,
    createdAt: intake.createdAt,
    text: intake.text.slice(0, 500),
    state,
    summary,
    links: items.flatMap((i) => i.state === "applied" ? (i.payload.readLinks as Array<{ label: string; href: string }> | undefined) ?? [] : []).filter((l) => typeof l.label === "string" && ["/today", "/week", "/direction", "/settings"].includes(l.href)),
    items: itemViews,
    understanding,
    changes: changes.slice(0, 30),
    questions,
    nextActions: nextActions.slice(0, 8),
    affectedDates: [...dates].sort(),
    followUps,
    undo: { available: !correctedRead && undoable.length > 0, batchIds: correctedRead ? [] : undoable, note: correctedRead ? "误建任务与学习块已取消，原始变更记录保留" : commandBatches.some((b) => b.status === "undone") ? "部分变更已撤销" : "" },
    snapshotRevision: snapshotRevision(),
    error: state === "failed" ? { message: failed[0]?.error ?? intake.lastError ?? "处理失败", recoverable: items.some((i) => i.state === "failed" && i.payload.retryable === true) } : null,
    goal,
  };
}

function goalView(intake: IntakeRow): IntakeResultView["goal"] {
  if (!intake.goalId) return null;
  const g = getGoal(intake.goalId);
  if (!g) return null;
  return { id: g.id, revision: g.revision, intakeRevision: intake.goalRevision ?? 1, current: (intake.goalRevision ?? 1) === g.revision, state: g.state, objective: g.objective.slice(0, 200) };
}

export function intakeResultById(id: string): IntakeResultView | null {
  const intake = getIntake(id);
  return intake ? intakeResultView(intake) : null;
}
