import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { createItem, getItem, listItems, updateItem, type IntakeItemRow } from "@/repositories/intakes";
import { listChanges } from "@/repositories/journal";
import type { EntityRef } from "@/repositories/conversations";
import type { Intent } from "@/domain/intent";
import { authorizeCommand } from "@/domain/authorization";
import { bindIntents, stepGroups, stepRefsOf, type BindEnv } from "./agent";

/**
 * 多步执行与确认绑定（Agent 增强 v1.1 P1）：
 * - 一句话里多个对象的修改拆成步骤事项，各自一个 journal 批次，可分别撤销；
 * - 后一步引用前一步的结果（{kind:"step"}）时，等前一步落库后再绑定，前一步失败则这一步不执行；
 * - 确认针对“绑定后的命令 + 涉及对象的版本”的指纹，对象在确认前变了，旧确认作废。
 */

const VERSIONED: Record<string, string> = { taskId: "tasks", sessionId: "plan_sessions", projectId: "projects", goalId: "goals", eventId: "fixed_events", practiceId: "practice_entries", candidateId: "candidates" };

function readVersions(command: Record<string, unknown>): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [field, table] of Object.entries(VERSIONED)) {
    const id = command[field];
    if (typeof id !== "string") continue;
    try {
      out[`${field}:${id}`] = (getDb().prepare(`SELECT version FROM ${table} WHERE id = ?`).get(id) as { version: number } | undefined)?.version ?? null;
    } catch {
      out[`${field}:${id}`] = null;
    }
  }
  return out;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

/** 绑定后的命令连同所涉对象当前版本的指纹 */
export function planHash(commands: Array<Record<string, unknown>>): string {
  return crypto.createHash("sha256").update(JSON.stringify(commands.map((c) => ({ c: stable(c), v: readVersions(c) })))).digest("hex").slice(0, 16);
}

export type PlanView = {
  commands: Array<Record<string, unknown>>;
  hash: string;
  /** 所有步骤都已绑定到具体命令 */
  bound: boolean;
  needsConfirm: boolean;
  /** 授权直接拒绝的原因 */
  denied: string | null;
};

/** Agent 推断的方案：先绑定，再按参数级授权判断是否需要确认 */
export function planOf(intents: Intent[], env: BindEnv, fallbackNeedsConfirm: boolean): PlanView {
  const commands: Array<Record<string, unknown>> = [];
  let bound = true;
  for (const group of stepGroups(intents)) {
    const b = bindIntents(group.map((i) => intents[i]!), env);
    if (b.kind === "run") commands.push(b.command);
    else if (b.kind !== "answer") bound = false;
  }
  let needsConfirm = bound ? false : fallbackNeedsConfirm;
  let denied: string | null = null;
  for (const c of commands) {
    const a = authorizeCommand(c as Record<string, unknown> & { command: string }, { origin: "inferred" });
    if (a.kind === "deny") denied ??= a.reason;
    if (a.kind === "confirm") needsConfirm = true;
  }
  return { commands, hash: bound ? planHash(commands) : planHash([{ intents } as unknown as Record<string, unknown>]), bound, needsConfirm, denied };
}

/**
 * 拆步骤：连续的时间规则合并成一步，其余意图各一步。第一步沿用原事项，其余新建 `${key}-sN`。
 * 返回第一步（已更新的原事项）。引用了自己或后面步骤的，那一步直接失败。
 */
export function splitSteps(intakeId: string, item: IntakeItemRow): IntakeItemRow {
  const intents = (item.payload.intents as Intent[] | undefined) ?? [];
  if (item.payload.stepKeys || intents.length < 2) return item;
  const groups = stepGroups(intents);
  if (groups.length < 2) return item;
  const groupOf: number[] = [];
  groups.forEach((g, gi) => g.forEach((i) => (groupOf[i] = gi)));
  const keyOf = (gi: number) => (gi === 0 ? item.stableItemKey : `${item.stableItemKey}-s${gi + 1}`);
  const stepKeys = intents.map((_, i) => keyOf(groupOf[i]!));
  const summary = String(item.payload.summary ?? "");
  let first = item;
  groups.forEach((g, gi) => {
    const own = g.map((i) => intents[i]!);
    const refs = own.flatMap(stepRefsOf);
    const bad = refs.find((s) => s < 1 || s > intents.length || groupOf[s - 1]! >= gi);
    const dependsOn = bad === undefined ? [...new Set(refs.map((s) => keyOf(groupOf[s - 1]!)))] : [];
    const payload = { ...item.payload, intents: own, stepKeys, stepIndex: gi + 1, stepTotal: groups.length, dependsOn, summary: `${summary.slice(0, 180)}（第 ${gi + 1}/${groups.length} 步）` };
    let row: IntakeItemRow;
    if (gi === 0) {
      updateItem(item.id, { payload });
      row = first = { ...item, payload };
    } else row = createItem({ intakeId, stableItemKey: keyOf(gi), kind: "command", payload, evidence: item.evidence }).item;
    if (bad !== undefined) updateItem(row.id, { state: "failed", waitingQuestionId: null, evidence: { ...item.evidence, error: `第 ${gi + 1} 步引用了第 ${bad} 步的结果，但那一步不在它之前，没有执行`, retryable: false } });
  });
  return getItem(item.id) ?? first;
}

export type DependencyState = { kind: "ready" } | { kind: "waiting" } | { kind: "failed"; error: string };

/** 前序步骤：都落库了才绑定；有一步没办成，这一步不执行 */
export function dependencyState(intakeId: string, item: IntakeItemRow): DependencyState {
  const deps = (item.payload.dependsOn as string[] | undefined) ?? [];
  if (!deps.length) return { kind: "ready" };
  const all = listItems(intakeId);
  for (const key of deps) {
    const d = all.find((x) => x.stableItemKey === key);
    if (!d || d.state === "failed" || d.state === "ignored") return { kind: "failed", error: `它依赖的上一步「${String(d?.payload.summary ?? key)}」没有完成，这一步没有执行` };
    if (d.state !== "applied") return { kind: "waiting" };
  }
  return { kind: "ready" };
}

/** 第 N 个意图所在步骤产生的对象（主批次 + 随后的重排批次）；那一步还没落库返回 null */
export function stepRefsFor(intakeId: string, item: IntakeItemRow): BindEnv["stepRefs"] {
  const keys = item.payload.stepKeys as string[] | undefined;
  if (!keys) return undefined;
  return (step: number) => {
    const key = keys[step - 1];
    if (!key) return null;
    const dep = listItems(intakeId).find((x) => x.stableItemKey === key);
    if (!dep || dep.state !== "applied") return null;
    const applied = dep.payload.applied as { batchId?: string | null; planBatchId?: string | null } | undefined;
    const refs: EntityRef[] = [];
    for (const batchId of [applied?.batchId, applied?.planBatchId]) {
      if (!batchId) continue;
      for (const c of listChanges(batchId)) {
        if (c.entityKind === "plan_session" && (c.after as { status?: string } | null)?.status === "superseded") continue;
        refs.push({ kind: c.entityKind, id: c.entityId });
      }
    }
    return refs;
  };
}
