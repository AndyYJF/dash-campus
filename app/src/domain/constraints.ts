import { z } from "zod";
import { refSchema } from "./intent";
import { addDays } from "./time";

/**
 * 目标约束（语义修复 W1）：主人在要求、回答和改口里说过的条件，变成有类型、可核对的结构。
 * 模型只能提出候选（每条带逐字引用）；引用必须出现在主人本人的话里才接受，资料/工具结果/文件里的文字不算。
 * 范围类（date_scope）以最新一版为准；保护类跨版本保留，直到主人明说解除（release）。
 */

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const excerpt = z.string().trim().min(1).max(200);
export const dayClassSchema = z.enum(["workday", "weekend"]);
export type DayClass = z.infer<typeof dayClassSchema>;

export const constraintValueSchema = z.discriminatedUnion("kind", [
  /** 这件事只涉及这几天（“只重排今天”“改成下周”） */
  z.object({ kind: z.literal("date_scope"), dateFrom: dateStr, dateTo: dateStr }),
  /** 工作日/周末的规则与安排都不动（“周末别动”） */
  z.object({ kind: z.literal("protect_days"), days: dayClassSchema }),
  /** 某几天不动（“别碰我放假那几天”） */
  z.object({ kind: z.literal("protect_dates"), dateFrom: dateStr, dateTo: dateStr }),
  /** 某个对象不动（“高数那块别动”） */
  z.object({ kind: z.literal("protect_entity"), ref: refSchema }),
  /** 几点之后不安排学习（只在这件事的范围内） */
  z.object({ kind: z.literal("no_study_after"), time: timeStr, days: z.enum(["all", "workday", "weekend"]).default("all") }),
]);
export type ConstraintValue = z.infer<typeof constraintValueSchema>;

const releaseSchema = z.object({ kind: z.literal("release"), target: z.enum(["date_scope", "protect_days", "protect_dates", "protect_entity", "no_study_after"]), days: dayClassSchema.optional() });

/** 模型提出的候选：约束或解除，都要带主人原话里的逐字引用 */
export const constraintCandidateSchema = z.union([constraintValueSchema, releaseSchema]).and(z.object({ excerpt }));
export type ConstraintCandidate = z.infer<typeof constraintCandidateSchema>;

export type ConstraintSource = "owner_text" | "owner_answer" | "rule_parse" | "inherited";
export type AcceptedConstraint = { value: ConstraintValue; excerpt: string; source: ConstraintSource };
export type ConstraintRelease = { target: z.infer<typeof releaseSchema>["target"]; days?: DayClass; excerpt: string; source: ConstraintSource };

/** 主人本人的话：原话片段与回答。资料、工具返回、文件内容不在这里 */
export type TrustedText = { text: string; source: "owner_text" | "owner_answer" };

const squash = (s: string) => s.replace(/\s+/g, "").replace(/[，,。.！!？?；;、]/g, "");

function quoted(ex: string, trusted: TrustedText[]): TrustedText | null {
  const e = squash(ex);
  if (!e) return null;
  return trusted.find((t) => squash(t.text).includes(e)) ?? null;
}

const validDate = (d: string) => !Number.isNaN(Date.parse(d)) && new Date(d).toISOString().slice(0, 10) === d;

/**
 * 候选 → 接受的约束：逐条校验类型、日期合法与范围（今天起一年内），引用必须在主人本人的话里。
 * 不合格的逐条丢弃并说明原因，不让一条坏候选拖垮整次决策。
 */
export function acceptConstraints(raw: unknown[], trusted: TrustedText[], today: string): { accepted: AcceptedConstraint[]; releases: ConstraintRelease[]; rejected: string[] } {
  const accepted: AcceptedConstraint[] = [];
  const releases: ConstraintRelease[] = [];
  const rejected: string[] = [];
  for (const r of raw.slice(0, 12)) {
    const parsed = constraintCandidateSchema.safeParse(r);
    if (!parsed.success) {
      rejected.push(`约束格式不对：${parsed.error.issues[0]?.message ?? ""}`);
      continue;
    }
    const c = parsed.data;
    const from = quoted(c.excerpt, trusted);
    if (!from) {
      rejected.push(`“${c.excerpt.slice(0, 30)}”不是你说的话，不作为约束`);
      continue;
    }
    if (c.kind === "release") {
      releases.push({ target: c.target, ...(c.days ? { days: c.days } : {}), excerpt: c.excerpt, source: from.source });
      continue;
    }
    if ((c.kind === "date_scope" || c.kind === "protect_dates") && (!validDate(c.dateFrom) || !validDate(c.dateTo) || c.dateTo < c.dateFrom || c.dateTo < today || c.dateFrom > addDays(today, 365))) {
      rejected.push(`“${c.excerpt.slice(0, 30)}”的日期范围无效`);
      continue;
    }
    const { excerpt: ex, ...value } = c;
    const checked = constraintValueSchema.safeParse(value);
    if (!checked.success) {
      rejected.push(`约束格式不对：${checked.error.issues[0]?.message ?? ""}`);
      continue;
    }
    const key = JSON.stringify(checked.data);
    if (accepted.some((a) => JSON.stringify(a.value) === key)) continue;
    accepted.push({ value: checked.data, excerpt: ex, source: from.source });
  }
  return { accepted, releases, rejected };
}

/** ISO 星期：周一=1 … 周日=7 */
export function isoWeekdayOf(date: string): number {
  return ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

export function dayClassOf(date: string): DayClass {
  return isoWeekdayOf(date) >= 6 ? "weekend" : "workday";
}

/** 这一天被哪条保护约束护着（没有返回 null） */
export function protectingConstraint(date: string, constraints: ConstraintValue[]): ConstraintValue | null {
  return constraints.find((c) => (c.kind === "protect_days" && c.days === dayClassOf(date)) || (c.kind === "protect_dates" && c.dateFrom <= date && date <= c.dateTo)) ?? null;
}

export function describeConstraint(c: ConstraintValue): string {
  switch (c.kind) {
    case "date_scope":
      return c.dateFrom === c.dateTo ? `只涉及 ${c.dateFrom}` : `只涉及 ${c.dateFrom} 至 ${c.dateTo}`;
    case "protect_days":
      return c.days === "weekend" ? "周末的作息、规则和安排不动" : "工作日的作息、规则和安排不动";
    case "protect_dates":
      return c.dateFrom === c.dateTo ? `${c.dateFrom} 不动` : `${c.dateFrom} 至 ${c.dateTo} 不动`;
    case "protect_entity":
      return `「${c.ref.kind === "named" ? c.ref.text : c.ref.kind === "id" ? c.ref.id : "刚才那个"}」不动`;
    case "no_study_after":
      return `${c.days === "workday" ? "工作日" : c.days === "weekend" ? "周末" : ""}${c.time} 之后不安排学习`;
  }
}
