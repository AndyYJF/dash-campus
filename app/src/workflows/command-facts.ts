import crypto from "node:crypto";
import { getDb } from "@/repositories/db";
import { OPERATIONS, type Command, type FactSet } from "@/contracts/commands";
import { instanceTimezone, tzOffsetMs } from "@/domain/time";
import { getSetting } from "@/repositories/settings";
import { AI_BUDGET_SETTINGS_KEY, aiBudgetSchema } from "@/contracts/review";

/**
 * 确认快照（语义修复 W2/R06）：按操作注册表声明的读取集合，读出命令依赖的当前事实。
 * 确认绑定“命令 + 这些事实”；确认前或执行事务内事实变了，旧确认作废并说明差异；集合外的变化不作废。
 */

const VERSIONED: Record<string, string> = { resourceId: "resources", taskId: "tasks", sessionId: "plan_sessions", projectId: "projects", goalId: "goals", eventId: "fixed_events", practiceId: "practice_entries", candidateId: "candidates", trackId: "direction_tracks", roadmapItemId: "roadmap_items", practiceEntryId: "practice_entries" };
const PREF_COLUMNS: Record<string, string> = { workdayStart: "workday_start", workdayEnd: "workday_end", weekendStart: "weekend_start", weekendEnd: "weekend_end", dailyLimitMinutes: "daily_limit_minutes", minBlockMinutes: "min_block_minutes", bufferPercent: "buffer_percent", commuteMinutes: "commute_minutes", meals: "meals_json" };
const PREF_LABELS: Record<string, string> = { workdayStart: "工作日开始时间", workdayEnd: "工作日结束时间", weekendStart: "周末开始时间", weekendEnd: "周末结束时间", dailyLimitMinutes: "每天上限", minBlockMinutes: "最短一段", bufferPercent: "机动比例", commuteMinutes: "交通时间", meals: "三餐时段" };

export type Facts = Record<string, unknown>;

type RuleLike = { kind?: string; weekday?: number | null; dateFrom?: string | null; dateTo?: string | null; value?: Record<string, unknown> };

function relatedRules(rules: RuleLike[], revokeIds: string[]): Array<{ id: string; version: number; status: string }> {
  const db = getDb();
  const active = db.prepare(`SELECT id, kind, weekday, date_from, date_to, value_json, version, status FROM planning_policy_rules WHERE status = 'active' OR id IN (${revokeIds.map(() => "?").join(",") || "''"}) ORDER BY id`).all(...revokeIds) as Array<{ id: string; kind: string; weekday: number | null; date_from: string | null; date_to: string | null; value_json: string; version: number; status: string }>;
  return active
    .filter((r) => revokeIds.includes(r.id) || rules.some((x) => {
      if (x.kind !== r.kind) return false;
      if (x.dateFrom && x.dateTo && r.date_from && r.date_to) return x.dateFrom <= r.date_to && r.date_from <= x.dateTo;
      if (x.kind === "weekday_limit") return x.weekday === r.weekday;
      if (x.kind === "group_limit") return JSON.parse(r.value_json).group === x.value?.group;
      return true;
    }))
    .map((r) => ({ id: r.id, version: r.version, status: r.status }));
}

const FIELD_KIND: Record<string, string> = { resourceId: "resource", taskId: "task", sessionId: "plan_session", projectId: "project", goalId: "goal", eventId: "fixed_event", practiceId: "practice_entry", candidateId: "candidate", trackId: "direction_track", roadmapItemId: "roadmap_item", practiceEntryId: "practice_entry" };
/** 通用对象字段（entityKind + entityId，如归档）能指向的对象类型与表 */
const ENTITY_TABLE: Record<string, string> = { task: "tasks", goal: "goals", course_set: "course_sets", plan_session: "plan_sessions", project: "projects" };

/**
 * 命令点名的对象（类型 + ID）：固定的对象字段，加上通用的 entityKind/entityId。
 * 确认快照与“这个别动”的核对用同一份解析，不会一处认得、另一处漏掉。
 */
export function commandEntities(command: Record<string, unknown>): Array<{ kind: string; id: string; table: string; key: string }> {
  const out: Array<{ kind: string; id: string; table: string; key: string }> = [];
  for (const [field, table] of Object.entries(VERSIONED)) {
    const id = command[field];
    if (typeof id === "string") out.push({ kind: FIELD_KIND[field]!, id, table, key: `${field}:${id}` });
  }
  const kind = command.entityKind;
  const id = command.entityId;
  if (typeof kind === "string" && typeof id === "string" && ENTITY_TABLE[kind]) out.push({ kind, id, table: ENTITY_TABLE[kind]!, key: `${kind}:${id}` });
  return out;
}

/** 命令依赖的事实：点名对象版本、要改的作息字段当前值、同类或日期重叠的规则 */
export function commandFacts(command: Record<string, unknown>): Facts {
  const name = command.command as Command["command"];
  const sets: FactSet[] = OPERATIONS[name]?.facts ?? ["entity"];
  const db = getDb();
  const out: Facts = {};
  for (const e of commandEntities(command)) {
    try {
      out[e.key] = (db.prepare(`SELECT version FROM ${e.table} WHERE id = ?`).get(e.id) as { version: number } | undefined)?.version ?? null;
    } catch {
      out[e.key] = null;
    }
  }
  if (sets.includes("preferences")) {
    const base = (command.base as Record<string, unknown> | undefined) ?? {};
    const keys = Object.keys(base).filter((k) => PREF_COLUMNS[k]);
    if (keys.length) {
      const row = db.prepare(`SELECT * FROM planning_preferences WHERE id = 1`).get() as Record<string, unknown> | undefined;
      for (const k of keys) out[`pref:${k}`] = row?.[PREF_COLUMNS[k]!] ?? null;
    }
  }
  if (sets.includes("ai_news_policy")) out.aiNewsPolicy = getSetting("aiNewsPolicy");
  if (sets.includes("agent_policy")) {
    const entry = getSetting(AI_BUDGET_SETTINGS_KEY);
    out.agentPolicy = { version: entry.version, value: aiBudgetSchema.parse(entry.value ?? {}) };
  }
  if (sets.includes("direction_profile")) {
    out.directionProfile = (db.prepare(`SELECT version FROM direction_profile WHERE id = 1`).get() as { version: number } | undefined)?.version ?? null;
  }
  if (sets.includes("rules")) {
    const rules = (command.rules as RuleLike[] | undefined) ?? [];
    const revoke = (command.revokeRuleIds as string[] | undefined) ?? [];
    if (rules.length || revoke.length) out.rules = relatedRules(rules, revoke);
  }
  return out;
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  return v;
}

export function hashOf(v: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable(v))).digest("hex").slice(0, 16);
}

export function factsHash(command: Record<string, unknown>): string {
  return hashOf(commandFacts(command));
}

const RULE_LABELS: Record<string, string> = { no_study: "不安排学习", date_limit: "当天学习上限", auto_reschedule: "允许重新安排", weekday_limit: "每周这天的上限", group_limit: "工作日/周末上限", holiday_policy: "节假日安排", preferred_window: "偏好时段" };

/**
 * 确认时给主人看的实际影响：作息字段 修改前 → 修改后、新增的长期/临时规则与日期、撤回几条、是否可撤销/有外部副作用。
 * 修改前的值取自确认快照，和确认指纹是同一份事实。
 */
export function describeImpact(command: Record<string, unknown>, facts: Facts): string[] {
  const name = command.command as Command["command"];
  const meta = OPERATIONS[name];
  if (name === "update_agent_policy") {
    const current = (facts.agentPolicy as { value?: Record<string, unknown> } | undefined)?.value ?? {};
    const out: string[] = [];
    if (command.dailyModelCalls !== undefined) out.push(`每日模型调用上限：${current.dailyModelCalls ?? "未设置"} → ${command.dailyModelCalls} 次（长期，每天重新计数）`);
    if (command.dailySearchCalls !== undefined) out.push(`每日搜索调用上限：${current.dailySearchCalls ?? "未设置"} → ${command.dailySearchCalls} 次（长期，每天重新计数）`);
    if (command.scheduledEnabled !== undefined) out.push(`定期探索和复盘：${current.scheduledEnabled ? "开启" : "关闭"} → ${command.scheduledEnabled ? "开启" : "关闭"}`);
    if (command.weeklyReview !== undefined) {
      const describe = (v: unknown) => { const t = v as { weekday: number; localTime: string } | null; return t ? `每周${"一二三四五六日"[t.weekday - 1]} ${t.localTime}` : "不定期运行"; };
      out.push(`定期复盘：${describe(current.weeklyReview)} → ${describe(command.weeklyReview)}`);
    }
    return out;
  }
  if (name === "link_resource") {
    const db = getDb();
    const existing = typeof command.resourceId === "string" ? db.prepare("SELECT title FROM resources WHERE id=?").get(command.resourceId) as { title: string } | undefined : undefined;
    const title = existing?.title || command.title || command.url || "提供的资料正文";
    const link = typeof command.resourceId === "string" ? db.prepare("SELECT role FROM resource_links WHERE resource_id=? ORDER BY created_at LIMIT 1").get(command.resourceId) as { role: string } | undefined : undefined;
    const role = String(command.role ?? link?.role ?? "reference");
    const roleLabel = { reference: "参考资料", requirement: "别人的要求", achievement: "自己的成果" }[role] ?? role;
    const project = typeof command.projectId === "string" ? db.prepare("SELECT title FROM projects WHERE id=?").get(command.projectId) as { title: string } | undefined : undefined;
    return [`将「${String(title).slice(0, 200)}」存为${roleLabel}${project ? `，关联项目「${project.title}」` : ""}；只存资料，不创建任务或安排学习时间`];
  }
  if (name !== "update_planning_policy") {
    if (!meta) return [];
    const notes = [
      ...(meta.undo === "none" ? ["做了不能撤销"] : []),
      ...(meta.sideEffects.includes("mail") ? ["会发出邮件，发出后不能撤回"] : []),
      ...(meta.sideEffects.includes("job") && !meta.sideEffects.includes("mail") ? ["在后台排队执行，结果稍后出现"] : []),
    ];
    return [`${objectImpact(command) ?? meta.title}${notes.length ? `（${notes.join("；")}）` : ""}`];
  }
  const out: string[] = [];
  const base = (command.base as Record<string, unknown> | undefined) ?? {};
  for (const [k, v] of Object.entries(base)) {
    if (!PREF_LABELS[k]) continue;
    const before = facts[`pref:${k}`];
    out.push(`${PREF_LABELS[k]}：${typeof before === "string" || typeof before === "number" ? String(before) : "未设置"} → ${typeof v === "object" ? "新设置" : String(v)}（长期）`);
  }
  for (const r of (command.rules as RuleLike[] | undefined) ?? []) {
    const raw = r as RuleLike & { scope?: string };
    const when = r.dateFrom ? ` ${r.dateFrom}${r.dateTo && r.dateTo !== r.dateFrom ? ` 至 ${r.dateTo}` : ""}` : r.weekday ? ` 每周${"一二三四五六日"[r.weekday - 1]}` : "";
    out.push(`${raw.scope === "persistent" ? "新增长期规则" : "临时"}：${RULE_LABELS[r.kind ?? ""] ?? r.kind}${when}`);
  }
  const revoke = (command.revokeRuleIds as string[] | undefined) ?? [];
  if (revoke.length) out.push(`撤回 ${revoke.length} 条规则`);
  return out;
}

const localStart = (utc: string) => {
  const at = new Date(utc);
  const d = new Date(at.getTime() + tzOffsetMs(at, instanceTimezone())).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
};

/** 具体对象的修改：对象名、修改前 → 修改后（只读当前数据） */
function objectImpact(command: Record<string, unknown>): string | null {
  const db = getDb();
  const taskTitle = (id: unknown) => (typeof id === "string" ? (db.prepare(`SELECT title FROM tasks WHERE id = ?`).get(id) as { title: string } | undefined)?.title : undefined) ?? "这项任务";
  const session = (id: unknown) => (typeof id === "string" ? (db.prepare(`SELECT s.start_utc, s.end_utc, t.title FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`).get(id) as { start_utc: string; end_utc: string; title: string } | undefined) : undefined);
  switch (command.command) {
    case "schedule_session":
      return `新增学习块：「${command.title ?? taskTitle(command.taskId)}」${command.date} ${command.startLocalTime} 起 ${command.durationMinutes} 分钟`;
    case "reschedule_session": {
      const s = session(command.sessionId);
      const to = [command.targetDate, command.startLocalTime].filter(Boolean).join(" ") || "同一天的其他时段";
      return `挪动学习块：「${s?.title ?? "这段学习"}」${s ? localStart(s.start_utc) : ""} → ${to}${command.durationMinutes ? `，改为 ${command.durationMinutes} 分钟` : ""}`;
    }
    case "pause_task":
      return command.resume ? `恢复任务「${taskTitle(command.taskId)}」` : `暂停任务「${taskTitle(command.taskId)}」${command.until ? `到 ${command.until}` : "（先不定恢复日期）"}，让出它未开始的学习块`;
    case "complete_task":
      return `把「${taskTitle(command.taskId)}」标为完成，取消它未开始的学习块与提醒`;
    case "archive_entity":
      return command.entityKind === "task" ? `归档任务「${taskTitle(command.entityId)}」` : command.entityKind === "course_set" ? "归档整套课表" : "归档这个目标";
    case "create_or_update_task": {
      if (typeof command.taskId !== "string") return `新建事项「${command.title ?? ""}」${command.dueLocalDate ? `，截止 ${command.dueLocalDate}` : ""}`;
      const row = db.prepare(`SELECT title, due_local_date FROM tasks WHERE id = ?`).get(command.taskId) as { title: string; due_local_date: string | null } | undefined;
      const changes = [
        ...("dueLocalDate" in command ? [`截止 ${row?.due_local_date ?? "未设"} → ${command.dueLocalDate ?? "不设"}`] : []),
        ...(command.priority ? [`优先级 → ${command.priority === "high" ? "优先" : "普通"}`] : []),
        ...("remainingMinutes" in command ? [`剩余 → ${command.remainingMinutes ?? "不设"} 分钟`] : []),
      ];
      return `修改「${row?.title ?? "这项任务"}」${changes.length ? `：${changes.join("，")}` : ""}`;
    }
    case "request_owner_digest":
      return `现在给你发一份${command.kind === "weekly" ? "本周" : "今日"}摘要邮件`;
    default:
      return null;
  }
}

/** 两次快照的差异，给主人看的说明（“工作日结束时间已从 23:00 变为 22:00”） */
export function describeFactsChange(before: Facts, after: Facts): string[] {
  const out: string[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = JSON.stringify(stable(before[key]));
    const b = JSON.stringify(stable(after[key]));
    if (a === b) continue;
    if (key.startsWith("pref:")) {
      const k = key.slice(5);
      out.push(`${PREF_LABELS[k] ?? k}已从 ${String(before[key] ?? "未设置")} 变为 ${String(after[key] ?? "未设置")}`);
    } else if (key === "rules") out.push("相关的时间规则有变化");
    else out.push("方案涉及的对象被改过");
  }
  return out;
}
