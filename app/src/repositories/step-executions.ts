import { getDb } from "./db";

/**
 * 步骤执行凭据（迁移 0033）：同一事项 + 同一操作只提交一次；记下批次与异步/外部结果引用。
 * 写入由执行器在领域事务里完成，这里只读。
 */

export type StepEffect = { kind: string; id: string };
export type StepExecutionRow = { itemId: string; command: string; intakeId: string | null; batchId: string | null; effects: StepEffect[]; summary: string; createdAt: string };

function mapRow(r: Record<string, unknown>): StepExecutionRow {
  return { itemId: r.item_id as string, command: r.command as string, intakeId: (r.intake_id as string | null) ?? null, batchId: (r.batch_id as string | null) ?? null, effects: JSON.parse(String(r.effects_json)) as StepEffect[], summary: r.summary as string, createdAt: r.created_at as string };
}

export function getStepExecution(itemId: string, command: string): StepExecutionRow | null {
  const r = getDb().prepare(`SELECT * FROM agent_step_executions WHERE item_id = ? AND command = ?`).get(itemId, command) as Record<string, unknown> | undefined;
  return r ? mapRow(r) : null;
}

/** 已执行步骤的结果引用（核验与恢复用） */
export function stepEffects(itemId: string): StepEffect[] {
  return (getDb().prepare(`SELECT * FROM agent_step_executions WHERE item_id = ?`).all(itemId) as Array<Record<string, unknown>>).flatMap((r) => mapRow(r).effects);
}

/** 引用了这个后台任务（或它对应的探索/复盘）的投递：任务结束后要重新核验 */
export function intakesAwaitingEffect(jobId: string): string[] {
  const db = getDb();
  const linked = [jobId];
  for (const t of ["exploration_runs", "reviews"]) {
    const r = db.prepare(`SELECT id FROM ${t} WHERE job_id = ?`).get(jobId) as { id: string } | undefined;
    if (r) linked.push(r.id);
  }
  const rows = db.prepare(`SELECT DISTINCT s.intake_id FROM agent_step_executions s, json_each(s.effects_json) e WHERE s.intake_id IS NOT NULL AND json_extract(e.value, '$.id') IN (${linked.map(() => "?").join(",")})`).all(...linked) as Array<{ intake_id: string }>;
  return rows.map((r) => r.intake_id);
}
