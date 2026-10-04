import crypto from "node:crypto";
import { getDb } from "./db";

/**
 * 服务端对话（REPAIR-PLAN §4.1.1）：主人原话、Agent 结果与涉及的对象引用按轮保存，
 * 刷新/换设备后继续；“刚才那个”“撤销刚才的调整”从这里消解，不靠浏览器记忆。
 */

export type EntityRef = { kind: string; id: string };

export type TurnRow = {
  id: string;
  conversationId: string;
  seq: number;
  role: "owner" | "agent";
  intakeId: string | null;
  questionId: string | null;
  text: string;
  refs: EntityRef[];
  batchIds: string[];
  createdAt: string;
};

const now = () => new Date().toISOString();
/** 隔了这么久再开口算新对话：上下文引用不跨到很久以前 */
const CONVERSATION_IDLE_MS = 6 * 3600_000;

function mapTurn(r: Record<string, unknown>): TurnRow {
  return {
    id: r.id as string,
    conversationId: r.conversation_id as string,
    seq: r.seq as number,
    role: r.role as TurnRow["role"],
    intakeId: (r.intake_id as string | null) ?? null,
    questionId: (r.question_id as string | null) ?? null,
    text: r.text as string,
    refs: JSON.parse(r.refs_json as string) as EntityRef[],
    batchIds: JSON.parse(r.batch_ids_json as string) as string[],
    createdAt: r.created_at as string,
  };
}

export function conversationExists(id: string): boolean {
  return Boolean(getDb().prepare(`SELECT 1 FROM conversations WHERE id = ?`).get(id));
}

/** 当前对话：最近一轮在空闲时限内就沿用，否则新开 */
export function currentConversationId(at: Date = new Date()): string {
  const db = getDb();
  const r = db.prepare(`SELECT id, updated_at FROM conversations WHERE status = 'open' ORDER BY updated_at DESC LIMIT 1`).get() as { id: string; updated_at: string } | undefined;
  if (r && at.getTime() - Date.parse(r.updated_at) < CONVERSATION_IDLE_MS) return r.id;
  if (r) db.prepare(`UPDATE conversations SET status = 'closed' WHERE id = ?`).run(r.id);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO conversations (id, status, created_at, updated_at) VALUES (?, 'open', ?, ?)`).run(id, at.toISOString(), at.toISOString());
  return id;
}

/** “继续这个目标”：目标所在的对话重新成为当前对话（跨空闲窗口），其他打开的对话收起 */
export function reopenConversation(id: string, at: Date = new Date()): void {
  const db = getDb();
  db.prepare(`UPDATE conversations SET status = 'closed' WHERE status = 'open' AND id != ?`).run(id);
  db.prepare(`UPDATE conversations SET status = 'open', updated_at = ? WHERE id = ?`).run(at.toISOString(), id);
}

export function latestConversationId(): string | null {
  return (getDb().prepare(`SELECT id FROM conversations ORDER BY updated_at DESC LIMIT 1`).get() as { id: string } | undefined)?.id ?? null;
}

export function appendTurn(input: { conversationId: string; role: "owner" | "agent"; intakeId?: string | null; questionId?: string | null; text: string; refs?: EntityRef[]; batchIds?: string[] }): TurnRow {
  const db = getDb();
  const id = crypto.randomUUID();
  const seq = ((db.prepare(`SELECT MAX(seq) AS s FROM conversation_turns WHERE conversation_id = ?`).get(input.conversationId) as { s: number | null }).s ?? 0) + 1;
  const t = now();
  db.prepare(
    `INSERT INTO conversation_turns (id, conversation_id, seq, role, intake_id, question_id, text, refs_json, batch_ids_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.conversationId, seq, input.role, input.intakeId ?? null, input.questionId ?? null, input.text, JSON.stringify(input.refs ?? []), JSON.stringify(input.batchIds ?? []), t);
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(t, input.conversationId);
  return mapTurn(db.prepare(`SELECT * FROM conversation_turns WHERE id = ?`).get(id) as Record<string, unknown>);
}

/** 一份投递对应一轮 Agent 结果：等回答后继续处理时更新同一轮，不重复追加 */
export function upsertAgentTurn(input: { conversationId: string; intakeId: string; text: string; refs: EntityRef[]; batchIds: string[] }): TurnRow {
  const db = getDb();
  const existing = db.prepare(`SELECT id FROM conversation_turns WHERE conversation_id = ? AND intake_id = ? AND role = 'agent'`).get(input.conversationId, input.intakeId) as { id: string } | undefined;
  if (!existing) return appendTurn({ ...input, role: "agent" });
  db.prepare(`UPDATE conversation_turns SET text = ?, refs_json = ?, batch_ids_json = ? WHERE id = ?`).run(input.text, JSON.stringify(input.refs), JSON.stringify(input.batchIds), existing.id);
  db.prepare(`UPDATE conversations SET updated_at = ? WHERE id = ?`).run(now(), input.conversationId);
  return mapTurn(db.prepare(`SELECT * FROM conversation_turns WHERE id = ?`).get(existing.id) as Record<string, unknown>);
}

export function listTurns(conversationId: string, opts: { limit?: number; beforeSeq?: number } = {}): TurnRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM conversation_turns WHERE conversation_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
    .all(conversationId, opts.beforeSeq ?? Number.MAX_SAFE_INTEGER, Math.min(opts.limit ?? 30, 100)) as Array<Record<string, unknown>>;
  return rows.map(mapTurn).reverse();
}

/** 某份投递之前、最近的 Agent 结果轮（新→旧）；“刚才那个”只在这些轮里找 */
export function agentTurnsBefore(conversationId: string, intakeId: string | null, limit = 5): TurnRow[] {
  const db = getDb();
  const owner = intakeId ? (db.prepare(`SELECT seq FROM conversation_turns WHERE conversation_id = ? AND intake_id = ? AND role = 'owner'`).get(conversationId, intakeId) as { seq: number } | undefined) : undefined;
  const rows = db
    .prepare(`SELECT * FROM conversation_turns WHERE conversation_id = ? AND role = 'agent' AND seq < ? ORDER BY seq DESC LIMIT ?`)
    .all(conversationId, owner?.seq ?? Number.MAX_SAFE_INTEGER, limit) as Array<Record<string, unknown>>;
  return rows.map(mapTurn);
}
