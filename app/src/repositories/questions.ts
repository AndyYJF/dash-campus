import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import type { QuestionStatus } from "@/contracts/intake";

/**
 * clarification_questions / answers 仓储（MASTER-PLAN §2.3）。
 * 同一 question_key 最多 1 个 open（部分唯一索引）；answer 先持久化再恢复依赖分支。
 */

export type QuestionRow = {
  id: string;
  questionKey: string;
  intakeId: string | null;
  itemId: string | null;
  fieldPath: string;
  prompt: string;
  options: string[] | null;
  status: QuestionStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** 用途决定回答由哪个解析器处理（§5.2） */
  purpose: string;
  /** 为什么需要问 */
  reason: string;
  /** 目标引用、候选、读版本、默认建议等（建议不是已提交答案） */
  context: Record<string, unknown>;
  conversationId: string | null;
};

export type AnswerRow = {
  id: string;
  questionId: string;
  rawText: string;
  structured: Record<string, unknown> | null;
  submittedAt: string;
};

const now = () => new Date().toISOString();

function mapQuestion(r: Record<string, unknown>): QuestionRow {
  return {
    id: r.id as string,
    questionKey: r.question_key as string,
    intakeId: (r.intake_id as string | null) ?? null,
    itemId: (r.item_id as string | null) ?? null,
    fieldPath: r.field_path as string,
    prompt: r.prompt as string,
    options: r.options_json ? (JSON.parse(r.options_json as string) as string[]) : null,
    status: r.status as QuestionStatus,
    version: r.version as number,
    createdAt: r.created_at as string,
    updatedAt: r.updated_at as string,
    purpose: (r.purpose as string) ?? "semester_anchor",
    reason: (r.reason as string) ?? "",
    context: r.context_json ? (JSON.parse(r.context_json as string) as Record<string, unknown>) : {},
    conversationId: (r.conversation_id as string | null) ?? null,
  };
}

function mapAnswer(r: Record<string, unknown>): AnswerRow {
  return {
    id: r.id as string,
    questionId: r.question_id as string,
    rawText: r.raw_text as string,
    structured: r.structured_json ? (JSON.parse(r.structured_json as string) as Record<string, unknown>) : null,
    submittedAt: r.submitted_at as string,
  };
}

export function getQuestion(id: string): QuestionRow | null {
  const row = getDb().prepare(`SELECT * FROM clarification_questions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? mapQuestion(row) : null;
}

/** 该缺口的 open 问题（全局唯一；无则 null） */
export function openQuestionByKey(questionKey: string): QuestionRow | null {
  const row = getDb()
    .prepare(`SELECT * FROM clarification_questions WHERE question_key = ? AND status = 'open'`)
    .get(questionKey) as Record<string, unknown> | undefined;
  return row ? mapQuestion(row) : null;
}

/** 该缺口最近一次已答问题的回答（恢复依赖分支时取锚点） */
export function latestAnswerForKey(questionKey: string): AnswerRow | null {
  const row = getDb()
    .prepare(
      `SELECT a.* FROM clarification_answers a
       JOIN clarification_questions q ON q.id = a.question_id
       WHERE q.question_key = ? ORDER BY a.submitted_at DESC LIMIT 1`,
    )
    .get(questionKey) as Record<string, unknown> | undefined;
  return row ? mapAnswer(row) : null;
}

/**
 * 确保缺口有一个 open 问题：已有 open 直接返回（多份材料共享），
 * 否则创建；并发创建撞唯一索引时重读返回既有 open。
 */
export function ensureOpenQuestion(input: {
  questionKey: string;
  intakeId: string | null;
  itemId: string | null;
  fieldPath: string;
  prompt: string;
  options?: string[] | null;
  purpose?: string;
  reason?: string;
  context?: Record<string, unknown>;
  conversationId?: string | null;
}): { question: QuestionRow; created: boolean } {
  const db = getDb();
  const existing = openQuestionByKey(input.questionKey);
  if (existing) return { question: existing, created: false };
  const id = crypto.randomUUID();
  const t = now();
  try {
    db.prepare(
      `INSERT INTO clarification_questions (id, question_key, intake_id, item_id, field_path, prompt, options_json, status, purpose, reason, context_json, conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`,
    ).run(id, input.questionKey, input.intakeId, input.itemId, input.fieldPath, input.prompt, input.options ? JSON.stringify(input.options) : null, input.purpose ?? "semester_anchor", input.reason ?? "", JSON.stringify(input.context ?? {}), input.conversationId ?? null, t, t);
    return { question: getQuestion(id)!, created: true };
  } catch (e) {
    if ((e as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE" || (e as { code?: string }).code === "SQLITE_CONSTRAINT") {
      const raced = openQuestionByKey(input.questionKey);
      if (raced) return { question: raced, created: false };
    }
    throw e;
  }
}

export function listOpenQuestions(limit = 50): QuestionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM clarification_questions WHERE status = 'open' ORDER BY created_at LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(mapQuestion);
}

/** 最近一组待答问题（不含指定投递自己的问题），组内仍按旧→新排列，避免历史积压挤掉刚问的问题 */
export function openQuestionsInConversation(conversationId: string, exceptIntakeId: string | null, limit = 10): QuestionRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM clarification_questions WHERE status = 'open' AND conversation_id = ? AND intake_id IS NOT ? ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(conversationId, exceptIntakeId, limit) as Array<Record<string, unknown>>;
  return rows.reverse().map(mapQuestion);
}

export function listQuestionsForIntake(intakeId: string): QuestionRow[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT q.* FROM clarification_questions q
       LEFT JOIN intake_items i ON i.waiting_question_id = q.id
       WHERE q.intake_id = ? OR i.intake_id = ?
       ORDER BY q.created_at`,
    )
    .all(intakeId, intakeId) as Array<Record<string, unknown>>;
  return rows.map(mapQuestion);
}

export type AnswerResult =
  | { kind: "answered"; answer: AnswerRow }
  | { kind: "stale" }        // expectedVersion 不匹配（过时回答）
  | { kind: "not_open" };    // 已答/已取代/已搁置

/**
 * 保存回答并把问题落为 answered：先存答案再推进状态，进程中断后答案仍在（§2.3）。
 * 版本条件更新防过时回答。
 */
export function recordAnswer(input: {
  questionId: string;
  expectedVersion: number;
  rawText: string;
  structured: Record<string, unknown> | null;
}): AnswerResult {
  const db = getDb();
  const t = now();
  return db.transaction((): AnswerResult => {
    const q = getQuestion(input.questionId);
    if (!q || q.status !== "open") return { kind: "not_open" };
    if (q.version !== input.expectedVersion) return { kind: "stale" };
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO clarification_answers (id, question_id, raw_text, structured_json, submitted_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.questionId, input.rawText, input.structured ? JSON.stringify(input.structured) : null, t);
    const r = db
      .prepare(`UPDATE clarification_questions SET status = 'answered', version = version + 1, updated_at = ? WHERE id = ? AND status = 'open' AND version = ?`)
      .run(t, input.questionId, input.expectedVersion);
    if (r.changes !== 1) return { kind: "stale" };
    return { kind: "answered", answer: { id, questionId: input.questionId, rawText: input.rawText, structured: input.structured, submittedAt: t } };
  }).immediate();
}

/** 该缺口是否问过（任何状态）：同一件事不反复追问 */
export function questionEverAsked(questionKey: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM clarification_questions WHERE question_key = ?`).get(questionKey));
}

/** 新材料/新事实补齐后旧问题失效：不再继续追问 */
export function supersedeQuestion(id: string): void {
  getDb().prepare(`UPDATE clarification_questions SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ? AND status = 'open'`).run(now(), id);
}
