import { getDb } from "@/repositories/db";
import { bumpPlanningRevision } from "@/repositories/proposals";
import type { ChangeInput } from "@/repositories/journal";
import type { Command, CommandContext } from "@/contracts/commands";
import { addDays, instanceTimezone, wallTimeToUtc } from "@/domain/time";
import { activePolicyRules, getPolicyRule, insertPolicyRule, revokePolicyRule } from "@/repositories/calendar-facts";
import type { PolicyRule } from "@/domain/day-policy";
import { HttpError } from "@/workflows/http";

/**
 * 时间政策操作（REPAIR-PLAN §4.1/§5.1.1）：持久规则与临时覆盖分开保存，授权有具体范围、可撤回。
 * “今晚不学”只关当天；“以后周三最多一小时”是持久规则；模糊的一次表达不记成长期上限。
 */

type Cmd<N extends Command["command"]> = Extract<Command, { command: N }>;
type RuleInput = Cmd<"update_planning_policy">["rules"][number];

const now = () => new Date().toISOString();
const WEEKDAY = "一二三四五六日";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const BASE_COLUMNS: Record<string, string> = {
  workdayStart: "workday_start",
  workdayEnd: "workday_end",
  weekendStart: "weekend_start",
  weekendEnd: "weekend_end",
  dailyLimitMinutes: "daily_limit_minutes",
  minBlockMinutes: "min_block_minutes",
  bufferPercent: "buffer_percent",
  commuteMinutes: "commute_minutes",
};

function validateRule(r: RuleInput): void {
  const v = r.value;
  const minutes = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= 960;
  if (r.kind === "weekday_limit") {
    if (!r.weekday || !minutes(v.limitMinutes)) throw new HttpError(422, "VALIDATION", "按星期的上限需要星期和分钟数");
  } else if (r.kind === "group_limit") {
    if (!["workday", "weekend"].includes(v.group as string) || !minutes(v.limitMinutes)) throw new HttpError(422, "VALIDATION", "工作日/周末上限需要分组和分钟数");
  } else if (r.kind === "date_limit") {
    if (!r.dateFrom || !r.dateTo || r.dateTo < r.dateFrom || !minutes(v.limitMinutes)) throw new HttpError(422, "VALIDATION", "某几天的上限需要日期范围和分钟数");
  } else if (r.kind === "no_study") {
    if (!r.dateFrom || !r.dateTo || r.dateTo < r.dateFrom) throw new HttpError(422, "VALIDATION", "不安排学习需要具体日期范围");
    for (const t of [v.fromTime, v.toTime]) if (t !== undefined && (typeof t !== "string" || !TIME.test(t))) throw new HttpError(422, "VALIDATION", "时刻格式应为 HH:MM");
  } else if (r.kind === "holiday_policy") {
    if (!["weekend_template", "reduced", "none"].includes(v.mode as string)) throw new HttpError(422, "VALIDATION", "假期策略只支持按周末时段、少排或不安排");
  } else if (r.kind === "preferred_window") {
    if (!["morning", "afternoon", "evening", "weekend"].includes(v.part as string)) throw new HttpError(422, "VALIDATION", "偏好的时段只支持上午/下午/晚上/周末");
  } else if (r.kind === "auto_reschedule") {
    if (!r.dateFrom || !r.dateTo || r.dateTo < r.dateFrom) throw new HttpError(422, "VALIDATION", "重新安排的授权需要具体日期范围");
  }
}

/** 同一含义的旧规则被新规则取代，而不是并存 */
function sameSlot(existing: PolicyRule, r: RuleInput): boolean {
  if (existing.kind !== r.kind) return false;
  if (r.kind === "weekday_limit") return existing.weekday === r.weekday;
  if (r.kind === "group_limit") return existing.value.group === r.value.group;
  if (r.kind === "holiday_policy" || r.kind === "preferred_window") return true;
  return existing.dateFrom === (r.dateFrom ?? null) && existing.dateTo === (r.dateTo ?? null);
}

function describeRule(r: RuleInput): string {
  const v = r.value;
  if (r.kind === "weekday_limit") return `以后周${WEEKDAY[r.weekday! - 1]}最多安排 ${v.limitMinutes} 分钟`;
  if (r.kind === "group_limit") return `以后${v.group === "workday" ? "工作日" : "周末"}每天最多安排 ${v.limitMinutes} 分钟`;
  if (r.kind === "date_limit") return `${r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} 至 ${r.dateTo}`} 每天最多安排 ${v.limitMinutes} 分钟（只这一次，不改长期规则）`;
  if (r.kind === "no_study") {
    const range = r.dateFrom === r.dateTo ? r.dateFrom! : `${r.dateFrom} 至 ${r.dateTo}`;
    return v.fromTime ? `${range} ${v.fromTime} 之后不安排学习（只这一次）` : `${range} 不安排学习`;
  }
  if (r.kind === "holiday_policy") return `假期${v.mode === "weekend_template" ? "按周末时段安排" : v.mode === "reduced" ? `少排（每天最多 ${v.limitMinutes ?? 60} 分钟）` : "不安排学习"}${r.origin === "assumed" ? "（暂定）" : ""}`;
  if (r.kind === "preferred_window") return `集中学习优先放在${{ morning: "上午", afternoon: "下午", evening: "晚上", weekend: "周末" }[v.part as string]}`;
  return `${r.dateFrom === r.dateTo ? r.dateFrom : `${r.dateFrom} 至 ${r.dateTo}`} 的学习安排可以由我重新调整（不含锁定和已开始的）`;
}

export function applyPlanningPolicy(cmd: Cmd<"update_planning_policy">, ctx: CommandContext, changes: ChangeInput[]): string {
  const db = getDb();
  const parts: string[] = [];

  // 1) 基础模板字段：只改给出的；一句话修改即视为确认过当前作息
  const prefs = db.prepare(`SELECT * FROM planning_preferences WHERE id = 1`).get() as Record<string, unknown>;
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(cmd.base ?? {})) {
    if (value === undefined) continue;
    const column = field === "meals" ? "meals_json" : BASE_COLUMNS[field];
    if (!column) continue;
    const next = field === "meals" ? JSON.stringify(value) : value;
    if (prefs[column] === next) continue;
    before[field === "meals" ? "mealsJson" : field] = prefs[column];
    after[field === "meals" ? "mealsJson" : field] = next;
  }
  const start = (after.workdayStart ?? prefs.workday_start) as string;
  const end = (after.workdayEnd ?? prefs.workday_end) as string;
  const wStart = (after.weekendStart ?? prefs.weekend_start) as string;
  const wEnd = (after.weekendEnd ?? prefs.weekend_end) as string;
  if (start >= end || wStart >= wEnd) throw new HttpError(422, "VALIDATION", "可安排时段的结束必须晚于开始");
  const confirming = cmd.confirm && prefs.status !== "confirmed";
  if (confirming) {
    before.status = prefs.status;
    after.status = "confirmed";
  }
  if (Object.keys(after).length) {
    const sets = Object.keys(after).map((k) => `${k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`)} = ?`);
    db.prepare(`UPDATE planning_preferences SET ${sets.join(", ")}, version = version + 1, updated_at = ? WHERE id = 1`).run(...Object.values(after), now());
    changes.push({ entityKind: "planning_preferences", entityId: "1", action: "update", before, after, beforeVersion: prefs.version as number, afterVersion: (prefs.version as number) + 1 });
    const labels: Record<string, string> = { workdayStart: "工作日从", workdayEnd: "工作日到", weekendStart: "周末从", weekendEnd: "周末到", dailyLimitMinutes: "每天最多（分钟）", minBlockMinutes: "最短一段（分钟）", bufferPercent: "机动比例（%）", commuteMinutes: "课前后交通（分钟）", mealsJson: "三餐时段" };
    for (const [k, v] of Object.entries(after)) if (labels[k]) parts.push(`${labels[k]} ${k === "mealsJson" ? "已更新" : v}`);
    if (confirming) parts.push("作息已确认");
  }

  // 2) 撤回规则
  for (const id of cmd.revokeRuleIds) {
    const rule = getPolicyRule(id);
    if (!rule) throw new HttpError(404, "NOT_FOUND", "要撤回的规则不存在");
    if (rule.status !== "active") continue;
    revokePolicyRule(id);
    changes.push({ entityKind: "policy_rule", entityId: id, action: "update", before: { status: "active" }, after: { status: "revoked" }, beforeVersion: rule.version, afterVersion: rule.version + 1 });
    parts.push(`已撤回：${describeRule({ ...rule, value: rule.value } as RuleInput)}`);
  }

  // 3) 新规则（同一含义的旧规则被取代）
  const tz = instanceTimezone();
  for (const r of cmd.rules) {
    validateRule(r);
    const active = activePolicyRules();
    const same = active.find((x) => sameSlot(x, r));
    if (same && JSON.stringify(same.value) === JSON.stringify(r.value) && same.scope === r.scope && same.origin === r.origin) continue;
    if (same) {
      revokePolicyRule(same.id);
      changes.push({ entityKind: "policy_rule", entityId: same.id, action: "update", before: { status: "active" }, after: { status: "revoked" }, beforeVersion: same.version, afterVersion: same.version + 1 });
    }
    const id = insertPolicyRule({ kind: r.kind, weekday: r.weekday ?? null, dateFrom: r.dateFrom ?? null, dateTo: r.dateTo ?? null, value: r.value, scope: r.scope, origin: r.origin, evidence: cmd.evidence || ctx.evidence });
    changes.push({ entityKind: "policy_rule", entityId: id, action: "create", after: { kind: r.kind, weekday: r.weekday ?? null, dateFrom: r.dateFrom ?? null, dateTo: r.dateTo ?? null, value: r.value, scope: r.scope }, afterVersion: 1 });
    parts.push(describeRule(r));

    // 主人明确说这段时间不学：其中还没开始的学习块一并让出（含锁定的——是主人自己说不学）；已开始的保留已发生投入
    if (r.kind === "no_study" && r.origin === "user") {
      const from = wallTimeToUtc(r.dateFrom!, typeof r.value.fromTime === "string" ? r.value.fromTime : "00:00", tz).toISOString();
      const to = typeof r.value.toTime === "string" ? wallTimeToUtc(r.dateTo!, r.value.toTime, tz).toISOString() : wallTimeToUtc(addDays(r.dateTo!, 1), "00:00", tz).toISOString();
      const blocks = db.prepare(`SELECT id, status, version FROM plan_sessions WHERE status IN ('tentative','planned') AND end_utc > ? AND start_utc < ?`).all(from, to) as Array<{ id: string; status: string; version: number }>;
      for (const b of blocks) {
        db.prepare(`UPDATE plan_sessions SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`).run(now(), b.id);
        changes.push({ entityKind: "plan_session", entityId: b.id, action: "update", before: { status: b.status }, after: { status: "superseded" }, beforeVersion: b.version, afterVersion: b.version + 1 });
      }
      if (blocks.length) parts.push(`这段时间里 ${blocks.length} 个还没开始的学习块已让出，会另找时间`);
    }
  }

  if (!changes.length) return "时间安排的规则没有变化";
  bumpPlanningRevision();
  return parts.join("；");
}
