import { commandFacts, hashOf, type Facts } from "./command-facts";
import { createItem, getItem, listItems, updateItem, type IntakeItemRow } from "@/repositories/intakes";
import { listChanges } from "@/repositories/journal";
import type { EntityRef } from "@/repositories/conversations";
import type { Intent } from "@/domain/intent";
import { authorizeCommand } from "@/domain/authorization";
import { bindIntents, stepGroups, stepRefsOf, type BindEnv } from "./agent";
import { gateCommand, gateKey, type GateContext } from "./agent-gate";

/**
 * 多步执行与确认绑定（Agent 增强 v1.1 P1；语义修复 R06）：
 * - 一句话里多个对象的修改拆成步骤事项，各自一个 journal 批次，可分别撤销；
 * - 后一步引用前一步的结果（{kind:"step"}）时，等前一步落库后再绑定，前一步失败则这一步不执行；
 * - 确认针对“绑定后的命令 + 注册表声明的相关事实 + 授权范围与保护约束”的指纹，任何一项变了旧确认作废。
 */

/** 绑定后的命令连同相关事实快照、授权范围与保护的指纹 */
export function planHash(commands: Array<Record<string, unknown>>, gateKey = ""): string {
  return hashOf({ g: gateKey, p: commands.map((c) => ({ c, f: commandFacts(c) })) });
}

/** 确认时保存的事实快照（说明差异用） */
export function planFacts(commands: Array<Record<string, unknown>>): Facts[] {
  return commands.map(commandFacts);
}

export type PlanView = {
  /** 过门（按范围与保护约束收窄）后的命令 */
  commands: Array<Record<string, unknown>>;
  hash: string;
  /** 每一步各自的指纹：执行前逐步核对，任何一步变了旧确认作废 */
  stepHashes: string[];
  /** 所有步骤都已绑定到具体命令 */
  bound: boolean;
  needsConfirm: boolean;
  /** 授权或约束直接拒绝的原因 */
  denied: string | null;
  /** 按约束收窄了什么（给主人看） */
  notes: string[];
};

/** Agent 推断的方案：先绑定，再过统一门，再按参数级授权判断是否需要确认 */
export function planOf(intents: Intent[], env: BindEnv, fallbackNeedsConfirm: boolean, ctx: GateContext): PlanView {
  const commands: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  let bound = true;
  let denied: string | null = null;
  for (const group of stepGroups(intents)) {
    const b = bindIntents(group.map((i) => intents[i]!), env);
    if (b.kind === "run") {
      const g = gateCommand(b.command, b.replanDates ?? [], ctx);
      if (g.kind === "reject") denied ??= g.reason;
      else {
        commands.push(g.command);
        notes.push(...g.notes);
      }
    } else if (b.kind !== "answer") bound = false;
  }
  let needsConfirm = bound ? false : fallbackNeedsConfirm;
  for (const c of commands) {
    const a = authorizeCommand(c as Record<string, unknown> & { command: string }, { origin: "inferred", ownerPolicyProposal: env.ownerPolicyProposal === true });
    if (a.kind === "deny") denied ??= a.reason;
    if (a.kind === "confirm") needsConfirm = true;
  }
  const key = gateKey(ctx);
  return {
    commands,
    hash: bound ? planHash(commands, key) : planHash([{ intents } as unknown as Record<string, unknown>], key),
    stepHashes: bound ? commands.map((c) => planHash([c], key)) : [],
    bound,
    needsConfirm,
    denied,
    notes: [...new Set(notes)],
  };
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
