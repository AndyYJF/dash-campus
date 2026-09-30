import { PROFILE_FIELDS, type Tri } from "@/contracts/inbox";
import type { ConditionNode } from "@/contracts/inbox";

/**
 * 三值条件求值（计划 v1.2 第 5.2 节）。
 * all：任一 FALSE 则 FALSE，全 TRUE 才 TRUE，其余 UNKNOWN。
 * any：任一 TRUE 则 TRUE，全 FALSE 才 FALSE，其余 UNKNOWN。
 * 未填写的字段为 UNKNOWN；不支持的 field/op 保持 UNKNOWN，不凭模型分数折叠。
 */

export function evaluateCondition(node: ConditionNode, facts: Record<string, string>): Tri {
  if (node.kind === "leaf") {
    if (!(PROFILE_FIELDS as readonly string[]).includes(node.field)) return "UNKNOWN";
    if (node.op === "in" && typeof node.value === "string") return "UNKNOWN";
    if (node.op === "eq" && Array.isArray(node.value)) return "UNKNOWN";
    const fact = facts[node.field];
    if (fact === undefined) return "UNKNOWN";
    if (node.op === "eq") return fact === node.value ? "TRUE" : "FALSE";
    return node.value.includes(fact) ? "TRUE" : "FALSE";
  }
  if (node.kind === "all") {
    const results = node.children.map((c) => evaluateCondition(c, facts));
    if (results.includes("FALSE")) return "FALSE";
    if (results.every((r) => r === "TRUE")) return "TRUE";
    return "UNKNOWN";
  }
  const results = node.children.map((c) => evaluateCondition(c, facts));
  if (results.includes("TRUE")) return "TRUE";
  if (results.every((r) => r === "FALSE")) return "FALSE";
  return "UNKNOWN";
}
