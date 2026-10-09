import { OPERATIONS, type Command } from "@/contracts/commands";

/**
 * 参数级授权（Agent 增强 v1.1 §5.3）：同一个操作，按“谁提出的”和“具体改什么”决定能否直接执行。
 * - owner：主人本人的明确表达或按钮；
 * - inferred：Agent 自己推断出的修改（决策、目标运行里的补救），主人没有逐字说；
 * - material：资料正文、通知原文里的文字，永远不是授权。
 * 纯函数：不读库、不调模型，执行器和确认流程共用同一套判断。
 */

export type AuthOrigin = "owner" | "inferred" | "material";
export type AuthDecision = { kind: "allow" } | { kind: "confirm"; reason: string } | { kind: "deny"; reason: string };

/** 推断不得触碰：预算/主动程度、外部端点、停止别的处理 */
const INFERRED_NEVER = new Set<Command["command"]>(["update_agent_policy", "update_calendar_sync_policy", "cancel_operation"]);

type Raw = Record<string, unknown> & { command: string };

/** 只含临时上限/临时重排授权，不改长期模板、不撤销别的规则、不确认待定偏好 */
export function isBoundedTemporaryPolicy(cmd: Raw): boolean {
  if (cmd.command !== "update_planning_policy") return false;
  const base = cmd.base as Record<string, unknown> | undefined;
  if (base && Object.keys(base).length) return false;
  if (Array.isArray(cmd.revokeRuleIds) && cmd.revokeRuleIds.length) return false;
  if (cmd.confirm === true) return false;
  const rules = (cmd.rules as Array<{ kind?: string; scope?: string }> | undefined) ?? [];
  return rules.length > 0 && rules.every((r) => r.scope === "temporary" && (r.kind === "date_limit" || r.kind === "auto_reschedule"));
}

/** 推断下也能直接做的：新建（不改已有对象）且可撤销 */
function isPureCreate(cmd: Raw): boolean {
  if (cmd.command === "create_or_update_task") return !cmd.taskId;
  if (cmd.command === "record_practice") return true;
  return false;
}

export function authorizeCommand(cmd: Raw, opts: { origin: AuthOrigin; confirmed?: boolean; ownerPolicyProposal?: boolean }): AuthDecision {
  const meta = (OPERATIONS as Record<string, (typeof OPERATIONS)[keyof typeof OPERATIONS] | undefined>)[cmd.command];
  if (!meta) return { kind: "deny", reason: `未注册的操作「${cmd.command}」` };
  if (meta.authorization === "never") return { kind: "deny", reason: `「${meta.title}」不开放给 Agent` };
  if (opts.origin === "material") {
    return meta.authorization === "auto" ? { kind: "allow" } : { kind: "deny", reason: `「${meta.title}」需要你本人明确提出，资料里的文字不能触发` };
  }
  if (opts.origin === "owner") {
    return meta.authorization === "confirm" && !opts.confirmed ? { kind: "confirm", reason: `「${meta.title}」执行前需要你再确认一次` } : { kind: "allow" };
  }
  // 主人输入产生的设置提案只允许等待明确确认，模型输出本身不是额度授权。
  // 此标记由服务端写入，资料/后台规划不能携带；普通 confirmed 不解除 INFERRED_NEVER。
  if (cmd.command === "update_agent_policy" && opts.ownerPolicyProposal === true) {
    return opts.confirmed ? { kind: "allow" } : { kind: "confirm", reason: "按你提出的设置要求形成了具体策略，确认每日上限和修改内容后才执行" };
  }
  // inferred
  if (INFERRED_NEVER.has(cmd.command as Command["command"])) return { kind: "deny", reason: `「${meta.title}」只能由你本人明确提出，Agent 不会自己决定` };
  if (isBoundedTemporaryPolicy(cmd)) return { kind: "allow" };
  if (meta.authorization === "auto" && isPureCreate(cmd)) return { kind: "allow" };
  if (opts.confirmed) return { kind: "allow" };
  return { kind: "confirm", reason: `「${meta.title}」是 Agent 推断的修改，需要你确认后才执行` };
}
