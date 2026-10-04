import type { ConditionNode, ProfileField } from "@/contracts/inbox";

/**
 * 身份事实的归一（MASTER-PLAN §7）：主人陈述和通知条件用同一套写法才能比较。
 * 只做写法归一（大一=一年级、江安校区=江安），不由兴趣或模糊说法推断资格。
 */

const YEAR_CN: Record<string, string> = { 一: "一年级", 二: "二年级", 三: "三年级", 四: "四年级", 五: "五年级" };

export const PROFILE_LABEL: Record<ProfileField, string> = { education_level: "学历层次", program: "专业", campus: "校区", grade_year: "入学年份", study_year: "年级" };

export function normalizeProfileValue(field: string, raw: string): string {
  const v = raw.trim();
  if (field === "education_level") {
    if (/研究生|硕士|博士|研[一二三]/.test(v)) return "研究生";
    if (/本科|大[一二三四五]/.test(v)) return "本科";
    return v;
  }
  if (field === "study_year") {
    const m = /(?:大|研)([一二三四五])/.exec(v) ?? /([一二三四五])年级/.exec(v);
    return m ? YEAR_CN[m[1]!]! : v;
  }
  if (field === "grade_year") {
    const m = /(\d{4})|(\d{2})(?=级)/.exec(v);
    return m ? (m[1] ?? `20${m[2]}`) : v;
  }
  if (field === "campus") return v.replace(/校区$/, "");
  if (field === "program") return v.replace(/专业$/, "");
  return v;
}

/** 通知条件里的取值也归一，和主人事实同一写法 */
export function normalizeCondition(node: ConditionNode): ConditionNode {
  if (node.kind === "leaf") {
    const value = Array.isArray(node.value) ? node.value.map((x) => normalizeProfileValue(node.field, x)) : normalizeProfileValue(node.field, node.value);
    return { ...node, value };
  }
  return { ...node, children: node.children.map(normalizeCondition) };
}

export type ProfileFactInput = { field: ProfileField; value: string };

/** 从主人第一人称的陈述里取明确的身份事实；“大一”意味着本科一年级，“研一”意味着研究生一年级 */
export function profileFactsFromText(text: string): ProfileFactInput[] {
  const out = new Map<ProfileField, string>();
  const undergrad = /大([一二三四五])/.exec(text);
  const grad = /研([一二三])/.exec(text);
  if (undergrad) {
    out.set("education_level", "本科");
    out.set("study_year", YEAR_CN[undergrad[1]!]!);
  } else if (grad) {
    out.set("education_level", "研究生");
    out.set("study_year", YEAR_CN[grad[1]!]!);
  }
  if (/本科生?/.test(text)) out.set("education_level", "本科");
  else if (/研究生|硕士生?|博士生?/.test(text) && !undergrad) out.set("education_level", "研究生");
  const grade = /([一二三四五])年级/.exec(text);
  if (grade && !out.has("study_year")) out.set("study_year", YEAR_CN[grade[1]!]!);
  const year = /(?:(\d{4})|(\d{2}))级/.exec(text);
  if (year) out.set("grade_year", year[1] ?? `20${year[2]}`);
  const campus = /(?:在|是)?([一-龥]{2,4})校区/.exec(text);
  if (campus) out.set("campus", campus[1]!.replace(/^(我在|在|是)/, ""));
  const program = /(?:我是|是|读|学)?([一-龥A-Za-z]{1,12})专业/.exec(text);
  if (program) out.set("program", program[1]!.replace(/^(我是|我读|我学|是|读|学)/, ""));
  return [...out].map(([field, value]) => ({ field, value }));
}

/** 条件树里主人事实还缺的第一个可问字段 */
export function firstUnknownLeaf(node: ConditionNode, facts: Record<string, string>): { field: string; values: string[]; quote: string } | null {
  if (node.kind === "leaf") {
    if (facts[node.field] !== undefined) return null;
    return { field: node.field, values: Array.isArray(node.value) ? node.value : [node.value], quote: node.quote };
  }
  for (const child of node.children) {
    const hit = firstUnknownLeaf(child, facts);
    if (hit) return hit;
  }
  return null;
}

/** 条件是否明确限定在某个取值上（如“仅研究生”） */
export function requiresValue(node: ConditionNode, field: string, value: string): boolean {
  if (node.kind === "leaf") return node.field === field && (Array.isArray(node.value) ? node.value.length === 1 && node.value[0] === value : node.value === value);
  if (node.kind === "all") return node.children.some((c) => requiresValue(c, field, value));
  return node.children.every((c) => requiresValue(c, field, value));
}
