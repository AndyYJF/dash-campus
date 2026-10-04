import type { Prefs } from "./budget";

/**
 * 当日时间政策（REPAIR-PLAN §4.1，ACADEMIC-CALENDAR §5）：纯函数。
 * 优先级：显式个人日期覆盖 → 已确认/暂定的假期策略 → 工作日/周末模板。
 * 国家补班不把个人窗口改成工作日模板；节假日放假不自动把预算变零。
 */

export type PolicyRuleKind = "weekday_limit" | "group_limit" | "no_study" | "holiday_policy" | "preferred_window" | "auto_reschedule";

export type PolicyRule = {
  id: string;
  kind: PolicyRuleKind;
  weekday: number | null;
  dateFrom: string | null;
  dateTo: string | null;
  value: Record<string, unknown>;
  scope: "persistent" | "temporary";
  origin: "user" | "assumed";
  evidence: string;
  version: number;
};

export type DayPolicy = {
  template: "workday" | "weekend";
  windowStart: string;
  windowEnd: string;
  dailyLimit: number;
  /** 当天不安排的当地时段；整天不学用 noStudy */
  closed: Array<[string, string]>;
  noStudy: boolean;
  /** 给用户看的依据：每条说明哪个数字来自哪条规则 */
  notes: string[];
  /** 有任何一条暂定假设参与了当天口径 */
  tentative: boolean;
};

/** ISO 星期：周一=1 … 周日=7 */
export function isoWeekday(dateLocal: string): number {
  return ((new Date(`${dateLocal}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
}

function covers(rule: PolicyRule, date: string): boolean {
  return (!rule.dateFrom || rule.dateFrom <= date) && (!rule.dateTo || date <= rule.dateTo);
}

export function resolveDayPolicy(date: string, prefs: Prefs, rules: PolicyRule[], civil: { isHoliday: boolean }): DayPolicy {
  const weekday = isoWeekday(date);
  let template: DayPolicy["template"] = weekday >= 6 ? "weekend" : "workday";
  let dailyLimit = prefs.dailyLimitMinutes;
  const notes: string[] = [];
  let tentative = prefs.status === "tentative";
  let noStudy = false;
  const closed: Array<[string, string]> = [];

  const group = rules.find((r) => r.kind === "group_limit" && r.value.group === template);
  if (group && typeof group.value.limitMinutes === "number") {
    dailyLimit = group.value.limitMinutes;
    notes.push(`${template === "workday" ? "工作日" : "周末"}上限 ${dailyLimit} 分钟`);
  }
  const perDay = rules.find((r) => r.kind === "weekday_limit" && r.weekday === weekday);
  if (perDay && typeof perDay.value.limitMinutes === "number") {
    dailyLimit = perDay.value.limitMinutes;
    notes.push(`周${"一二三四五六日"[weekday - 1]}上限 ${dailyLimit} 分钟`);
  }

  if (civil.isHoliday) {
    const holiday = rules.find((r) => r.kind === "holiday_policy");
    const mode = holiday?.value.mode;
    if (holiday?.origin === "assumed") tentative = true;
    if (mode === "weekend_template") {
      template = "weekend";
      notes.push(`假期按周末时段安排${holiday!.origin === "assumed" ? "（暂定）" : ""}`);
    } else if (mode === "reduced") {
      const cap = typeof holiday!.value.limitMinutes === "number" ? holiday!.value.limitMinutes : 60;
      dailyLimit = Math.min(dailyLimit, cap);
      notes.push(`假期少排，最多 ${dailyLimit} 分钟${holiday!.origin === "assumed" ? "（暂定）" : ""}`);
    } else if (mode === "none") {
      noStudy = true;
      notes.push(`假期不安排学习${holiday!.origin === "assumed" ? "（暂定）" : ""}`);
    }
  }

  // 显式个人日期覆盖最优先：整天不学，或从某个时刻起不学
  for (const r of rules.filter((x) => x.kind === "no_study" && covers(x, date))) {
    const from = typeof r.value.fromTime === "string" ? r.value.fromTime : null;
    const to = typeof r.value.toTime === "string" ? r.value.toTime : null;
    const label = typeof r.value.label === "string" ? r.value.label : "不安排学习";
    if (!from && !to) {
      noStudy = true;
      notes.push(`${label}（${r.dateFrom === r.dateTo ? "仅这一天" : `${r.dateFrom} 至 ${r.dateTo}`}）`);
    } else {
      closed.push([from ?? "00:00", to ?? "24:00"]);
      notes.push(`${label}（${from ?? "00:00"} 起${to ? `到 ${to}` : ""}，仅这一天）`);
    }
  }

  const [windowStart, windowEnd] = template === "weekend" ? [prefs.weekendStart, prefs.weekendEnd] : [prefs.workdayStart, prefs.workdayEnd];
  return { template, windowStart, windowEnd, dailyLimit, closed, noStudy, notes, tentative };
}
