import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { getIntake, listItems } from "@/repositories/intakes";
import type { FeedbackSubmitInput } from "@/contracts/intake";
import { intakeResultView } from "@/workflows/results";
import { capJson } from "@/workflows/agent-trace";

/**
 * 主人“理解错了”的纠错（Agent 方案 §6 P3）。
 * 理解快照（路由方式、各事项、动作批次）由服务器从投递记录取，不信任客户端；
 * 记录只用于本地导出评测草稿，90 天 TTL，不入业务导出，不改任何业务数据。
 */
export type FeedbackResult = { kind: "ok"; id: string } | { kind: "not_found" } | { kind: "item_not_found" } | { kind: "not_finished" };

export function recordFeedback(input: FeedbackSubmitInput, now = new Date()): FeedbackResult {
  const db = getDb();
  const intake = getIntake(input.intakeId);
  if (!intake) return { kind: "not_found" };
  if (intake.status === "received" || intake.status === "processing") return { kind: "not_finished" };
  if (input.itemId && !listItems(intake.id).some((i) => i.id === input.itemId)) return { kind: "item_not_found" };
  const view = intakeResultView(intake);
  const batches = db.prepare(`SELECT command, status FROM agent_action_batches WHERE intake_id = ? ORDER BY created_at, rowid`).all(intake.id) as Array<{ command: string; status: string }>;
  const routed = capJson({
    state: view.state,
    understanding: view.understanding,
    items: view.items.map((i) => ({ id: i.id, kind: i.kind, state: i.state, summary: i.summary, routedBy: i.routedBy, error: i.error })),
    batches,
    questions: view.questions.map((q) => q.prompt),
  });
  const trace = db.prepare(`SELECT id FROM agent_traces WHERE intake_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(intake.id) as { id: string } | undefined;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO agent_feedback (id, created_at, intake_id, item_id, trace_id, goal_id, owner_text, routed_json, verdict, expected_text)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  ).run(id, now.toISOString(), intake.id, input.itemId ?? null, trace?.id ?? null, intake.text.slice(0, 4000), routed.text, input.verdict, input.expectedText || null);
  return { kind: "ok", id };
}

export type FeedbackDraft = {
  feedbackId: string;
  createdAt: string;
  verdict: string;
  expectedText: string | null;
  routed: unknown;
  /** 语料条目草稿：expect 待人工标注、原话待人工脱敏后才能进 test/corpus */
  entry: { id: string; split: "dev"; text: string; referenceDate: string; expect: { kind: "TODO" }; source: "owner-feedback"; tags: string[] };
};

/** 导出未导出过的纠错为本地草稿并标 exported_at（all=true 时包括已导出的，不重复标记） */
export function exportFeedbackDrafts(opts: { all?: boolean; now?: Date } = {}): FeedbackDraft[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT f.id, f.created_at, f.verdict, f.expected_text, f.owner_text, f.routed_json, f.exported_at, i.reference_date FROM agent_feedback f LEFT JOIN intakes i ON i.id = f.intake_id ${opts.all ? "" : "WHERE f.exported_at IS NULL"} ORDER BY f.created_at, f.rowid`)
    .all() as Array<{ id: string; created_at: string; verdict: string; expected_text: string | null; owner_text: string; routed_json: string; exported_at: string | null; reference_date: string | null }>;
  const drafts = rows.map((r) => {
    let routed: unknown = null;
    try {
      routed = JSON.parse(r.routed_json);
    } catch {
      routed = r.routed_json;
    }
    return {
      feedbackId: r.id,
      createdAt: r.created_at,
      verdict: r.verdict,
      expectedText: r.expected_text,
      routed,
      entry: { id: "uTODO", split: "dev" as const, text: r.owner_text, referenceDate: r.reference_date ?? r.created_at.slice(0, 10), expect: { kind: "TODO" as const }, source: "owner-feedback" as const, tags: ["feedback", r.verdict] },
    };
  });
  const mark = db.prepare(`UPDATE agent_feedback SET exported_at = ? WHERE id = ? AND exported_at IS NULL`);
  const at = (opts.now ?? new Date()).toISOString();
  db.transaction(() => { for (const r of rows) mark.run(at, r.id); })();
  return drafts;
}
