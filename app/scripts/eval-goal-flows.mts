/**
 * Agent 方案 P4：目标续办的真实模型核对（多轮）。
 *   MODEL_PROTOCOL/MODEL_ENDPOINT/MODEL_API_KEY/MODEL_NAME 由环境变量给出：npx tsx scripts/eval-goal-flows.mts [--only id,id]
 * 每个流程在种子库副本上：先用脚本化模型把前置状态（已执行的方案、待答问题）走真实管线建出来，
 * 再换成真实模型只说“被考的那一句”，按目标/修订/问题状态核对。只用合成语料；报告写到 .planning/（不入库）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { buildTemplate, switchDb } from "../test/corpus/eval";
import { FIXTURE_NOW } from "../test/corpus/fixtures";
import { closeDb, getDb } from "../src/repositories/db";
import { setNowForTests } from "../src/domain/clock";
import { setProvidersForTests } from "../src/integrations";
import { OpenAIChatProvider } from "../src/integrations/openai-chat";
import { ScriptedChatProvider } from "../src/integrations/fake-model-provider";
import { probeModelCapabilities } from "../src/integrations/model-capabilities";
import { createSession, SESSION_COOKIE } from "../src/domain/session";
import { POST } from "../src/app/api/v2/intakes/route";
import { POST as answerRoute } from "../src/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "../src/worker/runner";
import { intakeResultById } from "../src/workflows/results";
import { getQuestion, latestAnswerForKey, listQuestionsForIntake } from "../src/repositories/questions";
import { getIntake } from "../src/repositories/intakes";
import { getGoal, listGoalRevisions } from "../src/repositories/goals";
import { listGoalConstraints } from "../src/repositories/goal-constraints";
import { INTAKE_JOB_TYPE } from "../src/contracts/intake";
import { executeOperation } from "../src/workflows/commands";
import type { ChatMessage } from "../src/integrations/model-json";
import { READ_ONLY_INTENTS } from "../src/domain/intent-catalog";
import type { Intent } from "../src/domain/intent";
import { getAiBudget, saveAiBudget } from "../src/workflows/ai-budget";
import { aiBudgetSchema } from "../src/contracts/review";

const { MODEL_PROTOCOL, MODEL_ENDPOINT, MODEL_API_KEY, MODEL_NAME } = process.env;
if (MODEL_PROTOCOL !== "openai-chat" || !MODEL_ENDPOINT || !MODEL_API_KEY || !MODEL_NAME) {
  console.log("RESULT: not_configured — 需要 MODEL_PROTOCOL=openai-chat、MODEL_ENDPOINT、MODEL_API_KEY、MODEL_NAME");
  process.exit(1);
}
const only = (() => { const i = process.argv.indexOf("--only"); return i >= 0 ? new Set(process.argv[i + 1]!.split(",")) : null; })();

type Setup = { text: string; decide: unknown };
type Ctx = { setup: string[]; live: string; lives: string[]; question: (setupIndex: number) => string | null; before: Record<string, string>; prompts: string[] };
/**
 * live 为数组时按顺序都由真实模型理解；answer 是对第一个前置投递待确认问题的原话回答（同样由真实模型理解）；
 * confirm 时像点结果卡上的按钮一样逐个确认“可以”；seed 在前置之前建数据，prepare 在前置之后
 */
/** approve：模拟会看确认内容的主人，返回 false 时回答“先不要”；不给则每个确认都答“可以” */
/** pick：主人怎么回答“你说的是哪一项”这类选项问题（返回选项原文）；不给则不回答这类问题 */
/** continueGoal：像点「继续这个目标」一样带 goalId；newSession+shiftMs：换会话并拨钟（S17） */
type Flow = { id: string; what: string; setup: Setup[]; live: string | string[]; answer?: string; confirm?: boolean; confirmSetup?: boolean; continueGoal?: boolean; newSession?: boolean; shiftMs?: number; approve?: (prompt: string) => boolean; replyViaChat?: boolean; confirmationReply?: (prompt: string, index: number) => string; trackRevisions?: boolean; beforeReply?: (prompt: string, purpose: string) => void; pick?: (prompt: string, options: string[]) => string | null; seed?: () => void; prepare?: () => void; check: (c: Ctx) => string[] };

const thisWeek = { kind: "act", rationale: "按课程与预算重排本周剩余时间", intents: [{ op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-18" }] };
const ask = (question: string, options: string[]) => ({ kind: "ask", question, reason: "几种安排差别明显", options });

const snapshot = () => {
  const db = getDb();
  return {
    aiPolicy: JSON.stringify(getAiBudget()),
    tasksFull: JSON.stringify(db.prepare("SELECT * FROM tasks ORDER BY id").all()),
    projectsFull: JSON.stringify(db.prepare("SELECT * FROM projects ORDER BY id").all()),
    openQuestions: JSON.stringify(db.prepare("SELECT id,intake_id,purpose,prompt FROM clarification_questions WHERE status='open' ORDER BY id").all()),
    facts: JSON.stringify([db.prepare(`SELECT id, status, version, priority, paused_until, due_local_date FROM tasks ORDER BY id`).all(), db.prepare(`SELECT id, start_utc, status, version, locked FROM plan_sessions ORDER BY id`).all()]),
    courses: JSON.stringify(db.prepare(`SELECT * FROM courses ORDER BY id`).all()),
    budget: JSON.stringify([db.prepare(`SELECT * FROM planning_policy_rules ORDER BY id`).all(), db.prepare(`SELECT * FROM planning_preferences`).all()]),
    budgetCore: JSON.stringify([db.prepare(`SELECT * FROM planning_policy_rules WHERE kind <> 'auto_reschedule' ORDER BY id`).all(), db.prepare(`SELECT * FROM planning_preferences`).all()]),
    replanWindows: JSON.stringify(db.prepare(`SELECT id, date_from, date_to FROM planning_policy_rules WHERE kind = 'auto_reschedule' AND status = 'active' ORDER BY id`).all()),
    weekend: protectedDays("2026-10-17", "2026-10-18"),
    nextWeekend: protectedDays("2026-10-24", "2026-10-25"),
  };
};
/** 某段日子（含）受保护的全部事实：周末作息模板、落在这些天的生效规则、未开始学习块 */
function protectedDays(from: string, to: string): string {
  const db = getDb();
  return JSON.stringify([
    db.prepare(`SELECT weekend_start, weekend_end FROM planning_preferences WHERE id = 1`).get(),
    db.prepare(`SELECT kind, weekday, date_from, date_to, value_json FROM planning_policy_rules WHERE status = 'active' AND ((date_from IS NOT NULL AND date_to >= ? AND date_from <= ?) OR weekday IN (0, 6)) ORDER BY id`).all(from, to),
    db.prepare(`SELECT id, start_utc, end_utc, status FROM plan_sessions WHERE status IN ('tentative','planned') AND date(start_utc, '+8 hours') BETWEEN ? AND ? ORDER BY id`).all(from, to),
  ]);
}
const prefsNow = () => getDb().prepare(`SELECT workday_end AS workdayEnd, weekend_end AS weekendEnd FROM planning_preferences WHERE id = 1`).get() as { workdayEnd: string; weekendEnd: string };
const OWNER = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: new Date(FIXTURE_NOW) };
const weekendSessions = () => {
  executeOperation({ command: "schedule_session", title: "英语阅读", date: "2026-10-17", startLocalTime: "10:00", durationMinutes: 60 }, OWNER);
  executeOperation({ command: "schedule_session", title: "英语听力", date: "2026-10-24", startLocalTime: "10:00", durationMinutes: 60 }, OWNER);
};
const lateAll = { kind: "act", rationale: "建议长期把每天学习结束时间提前到 22:00", intents: [{ op: "window_end", time: "22:00" }] };
const batchesOf = (intakeId: string) => (getDb().prepare(`SELECT COUNT(*) AS n FROM agent_action_batches WHERE intake_id = ?`).get(intakeId) as { n: number }).n;
const taskOf = (title: string) => getDb().prepare(`SELECT * FROM tasks WHERE title = ? AND archived_at IS NULL`).get(title) as Record<string, unknown> | undefined;
const verificationOf = (intakeId: string) => intakeResultById(intakeId)?.verification ?? null;
const goalOf = (intakeId: string) => getIntake(intakeId)?.goalId ?? null;
const revOf = (intakeId: string) => getIntake(intakeId)?.goalRevision ?? null;
const stateOf = (intakeId: string) => intakeResultById(intakeId)?.state ?? "missing";

/** 近期指代必须最终移动原任务的唯一60分钟块，不能只停在分类正确或待确认。 */
function checkRecentMove(c: Ctx): string[] {
  const out: string[] = [];
  if (stateOf(c.live) !== "applied") out.push(`确认后未执行：${stateOf(c.live)}`);
  if (!c.prompts.length) out.push("未经过确认/选择，缺少完整多轮证据");
  const task = taskOf("微积分复习");
  const rows = getDb().prepare("SELECT id,start_utc,end_utc FROM plan_sessions WHERE task_id=? AND status IN ('planned','tentative','in_progress')").all(task?.id ?? "missing") as Array<{ id: string; start_utc: string; end_utc: string }>;
  if (rows.length !== 1) out.push(`原任务有效学习块应有1段，实际${rows.length}`);
  const row = rows[0];
  if (row) {
    const local = new Date(Date.parse(row.start_utc) + 8 * 3600000).toISOString();
    if (!local.startsWith("2026-10-18") || Number(local.slice(11, 13)) >= 12) out.push(`没有保留周日上午：${local}`);
    if ((Date.parse(row.end_utc) - Date.parse(row.start_utc)) / 60000 !== 60) out.push("原60分钟丢失或增减");
    const previous = (JSON.parse(c.before.facts!) as Array<Array<{ id: string }>>)[1]!;
    if (!previous.some((r) => r.id === row.id)) out.push("原学习块被换成新对象，未完成原对象改期");
    const after = (JSON.parse(snapshot().facts) as Array<Array<{ id: string }>>)[1]!;
    if (JSON.stringify(previous.filter((r) => r.id !== row.id)) !== JSON.stringify(after.filter((r) => r.id !== row.id))) out.push("其他学习块被改变");
  }
  if ((JSON.parse(snapshot().facts) as unknown[][])[0]!.length !== (JSON.parse(c.before.facts!) as unknown[][])[0]!.length) out.push("出现额外任务");
  if (snapshot().courses !== c.before.courses) out.push("课程被修改");
  if (snapshot().budgetCore !== c.before.budgetCore) out.push("作息或长期预算被修改");
  if (listQuestionsForIntake(c.live).some((q) => q.status === "open")) out.push("仍有未回答问题");
  if (verificationOf(c.live)?.status !== "verified") out.push(`核验没有通过：${verificationOf(c.live)?.status}`);
  return out;
}

const seedAiPolicy = () => {
  const { budget, version } = getAiBudget();
  if (saveAiBudget(aiBudgetSchema.parse({ ...budget, dailyModelCalls: 150, dailySearchCalls: 30, scheduledEnabled: false, weeklyReview: null }), version) === "conflict") throw new Error("合成策略初始化冲突");
};
const unchangedUntilReply = (prompt: string, purpose: string) => {
  if (getAiBudget().budget.dailyModelCalls !== 150) throw new Error("明确确认前已经修改额度");
  if (purpose === "confirm" && !/每日模型调用上限：150.*(?:200|250|1000)/.test(prompt)) throw new Error(`确认没展示每日具体旧值和新值：${prompt}`);
};
function checkAiPolicy(c: Ctx, limit: number, requirePeriod = false): string[] {
  const out: string[] = [];
  const before = JSON.parse(c.before.aiPolicy!) as ReturnType<typeof getAiBudget>;
  const after = getAiBudget();
  if (after.budget.dailyModelCalls !== limit) out.push(`每日上限${after.budget.dailyModelCalls}，期望${limit}`);
  if (JSON.stringify({ ...after.budget, dailyModelCalls: before.budget.dailyModelCalls }) !== JSON.stringify(before.budget)) out.push("修改了其他策略字段");
  if (after.version !== before.version + 1) out.push(`策略应只保存一次：版本${before.version}→${after.version}`);
  const goalId = goalOf(c.live);
  const finalId = goalId ? listGoalRevisions(goalId).at(-1)?.intakeId ?? c.live : c.live;
  if (stateOf(finalId) !== "applied" || verificationOf(finalId)?.status !== "verified") out.push(`同一目标最新投递未完成核验：${stateOf(finalId)}/${verificationOf(finalId)?.status}`);
  if (listQuestionsForIntake(finalId).some((q) => q.status === "open")) out.push("同一目标最新要求仍有未答问题");
  const total = goalId ? listGoalRevisions(goalId).reduce((sum, revision, index, rows) => sum + (revision.intakeId && rows.findIndex((r) => r.intakeId === revision.intakeId) === index ? batchesOf(revision.intakeId) : 0), 0) : batchesOf(c.live);
  if (total !== 1) out.push(`同一目标应只有一次策略写入，实际${total}`);
  if (snapshot().facts !== c.before.facts || snapshot().courses !== c.before.courses || snapshot().budget !== c.before.budget) out.push("任务、学习块、课程或学习预算被修改");
  if (!c.prompts.some((p) => /每日模型调用上限：150/.test(p))) out.push("没有具体确认内容");
  if (requirePeriod && !c.prompts.some((p) => /→ 按每天/.test(p))) out.push("缺周期未经过统一聊天追问续答");
  // 种子里的课程/估时问题是其他业务，不要求一次额度修改顺便答完它们。
  // 但该目标所有修订中任何遗留问题都要失败，不能只核对最新投递。
  const waiting = goalId
    ? getDb().prepare("SELECT q.id FROM clarification_questions q JOIN intakes i ON i.id=q.intake_id WHERE q.status='open' AND i.goal_id=?").get(goalId)
    : getDb().prepare("SELECT id FROM clarification_questions WHERE status='open' AND intake_id=?").get(c.live);
  if (waiting) out.push("同一预算目标存在遗留待答问题");
  return out;
}

const FLOWS: Flow[] = [
  {
    id: "missing-resource-chat", what: "未带实际链接→Agent索取URL→统一聊天补URL→真实项目确认→单次创建并关联，无任务/学习副作用",
    setup: [], live: "这个链接是参考资料，放到科研项目下", confirm: true, replyViaChat: true,
    pick: (prompt, options) => /实际资料链接|请.*链接|链接.*贴/.test(prompt) ? "https://example.org/reference" : options.find((o) => /分类基线/.test(o)) ? "分类基线（科研项目）" : null,
    check: (c) => {
      const failures: string[] = [];
      if (stateOf(c.live) !== "applied" || verificationOf(c.live)?.status !== "verified") failures.push(`资料关联未核验完成：${stateOf(c.live)}/${verificationOf(c.live)?.status}`);
      const resources = getDb().prepare("SELECT id,url FROM resources WHERE url='https://example.org/reference'").all() as Array<{ id: string; url: string }>;
      if (resources.length !== 1) failures.push(`实际资料数量${resources.length}，期望1`);
      const project = getDb().prepare("SELECT id FROM projects WHERE title='分类基线（科研项目）'").get() as { id: string };
      const links = getDb().prepare("SELECT entity_id,role,origin FROM resource_links WHERE resource_id=?").all(resources[0]?.id ?? "missing") as Array<{ entity_id: string; role: string; origin: string }>;
      if (links.length !== 1 || links[0]?.entity_id !== project.id || links[0]?.role !== "reference" || links[0]?.origin !== "user") failures.push(`关联事实不符：${JSON.stringify(links)}`);
      const after = snapshot();
      if (after.tasksFull !== c.before.tasksFull || after.facts !== c.before.facts || after.projectsFull !== c.before.projectsFull || after.courses !== c.before.courses || after.budget !== c.before.budget || after.aiPolicy !== c.before.aiPolicy) failures.push("资料存档改变了学习或其他业务事实");
      if (!c.prompts.some((p) => /→ https:\/\/example\.org\/reference/.test(p))) failures.push("缺实际URL的统一聊天追问续答");
      if (!c.prompts.some((p) => /实际修改.*|将「https:\/\/example\.org\/reference」/.test(p) && /分类基线/.test(p))) failures.push("确认未展示实际来源和项目");
      if (listQuestionsForIntake(c.live).some((q) => q.status === "open")) failures.push("关联仍有遗留问题");
      if (batchesOf(c.live) !== 1) failures.push(`资料应写入一次，实际${batchesOf(c.live)}`);
      return failures;
    },
  },
  {
    id: "missing-task-chat", what: "不存在的讲座名称→真实对象追问→聊天选择院士报告报名→确认→仅该任务归档，其他事实不变",
    setup: [], live: "把那个讲座通知归档", confirm: true, replyViaChat: true,
    prepare: () => { const r = executeOperation({ command: "create_or_update_task", title: "院士报告报名", taskKind: "todo" }, OWNER); if (!r.result.ok) throw new Error(JSON.stringify(r)); },
    pick: (_prompt, options) => options.find((o) => /院士报告报名/.test(o)) ? "院士报告报名" : null,
    beforeReply: (prompt) => { if (taskOf("院士报告报名")?.archived_at) throw new Error("确认前已归档"); if (/是否|确认/.test(prompt) && /归档/.test(prompt) && !/院士报告报名/.test(prompt)) throw new Error("确认没有真实对象名称"); },
    check: (c) => {
      const failures: string[] = [];
      if (stateOf(c.live) !== "applied" || verificationOf(c.live)?.status !== "verified") failures.push(`归档未完成核验：${stateOf(c.live)}/${verificationOf(c.live)?.status}`);
      const old = JSON.parse(c.before.tasksFull!) as Array<Record<string, unknown>>;
      const now = JSON.parse(snapshot().tasksFull) as Array<Record<string, unknown>>;
      const target = old.find((r) => r.title === "院士报告报名");
      if (!target || !now.find((r) => r.id === target.id)?.archived_at) failures.push("选中任务实际没有归档");
      if (JSON.stringify(old.filter((r) => r.id !== target?.id)) !== JSON.stringify(now.filter((r) => r.id !== target?.id))) failures.push("其他任务被改变或有新任务");
      const previousSessions = (JSON.parse(c.before.facts!) as unknown[][])[1];
      if (JSON.stringify(previousSessions) !== JSON.stringify((JSON.parse(snapshot().facts) as unknown[][])[1])) failures.push("学习块被修改");
      if (snapshot().projectsFull !== c.before.projectsFull || snapshot().courses !== c.before.courses || snapshot().budget !== c.before.budget || snapshot().aiPolicy !== c.before.aiPolicy) failures.push("项目、课程或预算被修改");
      if (!c.prompts.some((p) => /→ 院士报告报名/.test(p))) failures.push("没有经统一聊天选择真实任务");
      if (listQuestionsForIntake(c.live).some((q) => q.status === "open")) failures.push("同一投递有遗留问题");
      if (batchesOf(c.live) !== 1) failures.push(`归档写入次数${batchesOf(c.live)}，应为1`);
      return failures;
    },
  },
  {
    id: "missing-project-chat", what: "不存在的论文复现实验项目→聊天指认真实科研项目→创建阅读综述并引用新任务定时30分钟，只创建一次",
    setup: [], live: "在论文复现实验项目里加一项阅读综述，明天下午两点做半小时", confirm: true, replyViaChat: true,
    pick: (_prompt, options) => options.find((o) => /分类基线/.test(o)) ? "分类基线（科研项目）" : null,
    check: (c) => {
      const failures: string[] = [];
      if (stateOf(c.live) !== "applied" || verificationOf(c.live)?.status !== "verified") failures.push(`两步未完成核验：${stateOf(c.live)}/${verificationOf(c.live)?.status}`);
      const target = taskOf("阅读综述");
      const project = getDb().prepare("SELECT id FROM projects WHERE title='分类基线（科研项目）'").get() as { id: string } | undefined;
      if (!target || target.project_id !== project?.id) failures.push("新任务没有关联选定的真实项目");
      const sessions = getDb().prepare("SELECT start_utc,end_utc FROM plan_sessions WHERE task_id=? AND status IN ('planned','tentative','in_progress')").all(target?.id ?? "missing") as Array<{ start_utc: string; end_utc: string }>;
      if (sessions.length !== 1 || sessions[0]?.start_utc !== "2026-10-13T06:00:00.000Z" || Date.parse(sessions[0]?.end_utc ?? "") - Date.parse(sessions[0]?.start_utc ?? "") !== 30 * 60000) failures.push(`指定30分钟未落实：${JSON.stringify(sessions)}`);
      const old = JSON.parse(c.before.tasksFull!) as Array<Record<string, unknown>>;
      const now = JSON.parse(snapshot().tasksFull) as Array<Record<string, unknown>>;
      if (now.length !== old.length + 1 || JSON.stringify(old) !== JSON.stringify(now.filter((r) => r.id !== target?.id))) failures.push("任务重复创建或修改了其他任务");
      if (snapshot().projectsFull !== c.before.projectsFull || snapshot().courses !== c.before.courses || snapshot().budget !== c.before.budget || snapshot().aiPolicy !== c.before.aiPolicy) failures.push("项目、课程或预算被修改");
      if (!c.prompts.some((p) => /→ 分类基线/.test(p))) failures.push("没有经聊天选择真实项目");
      if (listQuestionsForIntake(c.live).some((q) => q.status === "open")) failures.push("原目标仍有未答问题");
      return failures;
    },
  },
  {
    id: "policy-explicit-chat", what: "真实模型理解中文每日两百五十次→统一聊天可以→具体策略保存一次且其他事实不变",
    setup: [], live: "模型每日调用上限设为两百五十次", confirm: true, replyViaChat: true, prepare: seedAiPolicy,
    beforeReply: unchangedUntilReply, check: (c) => checkAiPolicy(c, 250),
  },
  {
    id: "policy-period-chat", what: "未说明周期的一千次→Agent主动追问→聊天回答按每天→具体确认→保存每日1000次",
    setup: [], live: "把模型额度调到一千次", confirm: true, replyViaChat: true, prepare: seedAiPolicy,
    beforeReply: unchangedUntilReply,
    pick: () => "按每天", check: (c) => checkAiPolicy(c, 1000, true),
  },
  {
    id: "policy-revise-chat", what: "每日250待确认→自然语言改成两百次→按150到200重新确认→只保存200一次，原方案不落库",
    setup: [], live: "模型每日调用上限设为两百五十次", confirm: true, replyViaChat: true, prepare: seedAiPolicy,
    beforeReply: unchangedUntilReply,
    confirmationReply: (_prompt, index) => index === 0 ? "改成两百次" : "可以", trackRevisions: true,
    check: (c) => { const failures = checkAiPolicy(c, 200); if (!c.prompts.some((p) => /150.*250/.test(p)) || !c.prompts.some((p) => /150.*200/.test(p))) failures.push("缺原方案与改口后的新方案确认"); return failures; },
  },

  {
    id: "recent-reference-known", what: "已有前文‘刚排的那个’→保留周日上午目标→确认后原微积分60分钟块实际改期，其他事实不变",
    setup: [], live: "刚排的那个换到周日上午", confirm: true, check: checkRecentMove,
  },
  {
    id: "recent-reference-clarify", what: "无前文‘刚排的那个’→选择微积分→确认后保留原周日上午目标，原60分钟只移动一次",
    setup: [], live: "刚排的那个换到周日上午", confirm: true,
    prepare: () => { getDb().prepare("DELETE FROM conversation_turns").run(); },
    pick: (_prompt, options) => options.find((o) => o.includes("微积分复习")) ?? "微积分复习",
    check: checkRecentMove,
  },

  {
    id: "crossday-source-date", what: "周四是来源日；真实模型提出腾空并重排、主人确认后腾空周四，原任务确实迁到其他日且30分钟不丢失不重复，课程与任务总数不变",
    setup: [], live: "周四课满，那天别排学习了，挪到别的天", confirm: true,
    seed: () => {
      const r = executeOperation({ command: "schedule_session", title: "跨天测试的数学练习", date: "2026-10-15", startLocalTime: "21:30", durationMinutes: 30 }, OWNER);
      if (!r.result.ok) throw new Error(`来源学习块未能种下：${JSON.stringify(r.result)}`);
      if (!(getDb().prepare("SELECT id FROM plan_sessions WHERE date(start_utc, '+8 hours')='2026-10-15' AND status IN ('planned','tentative')").get())) throw new Error("来源日没有实际学习块，不能验收腾空");
    },
    check: (c) => {
      const out: string[] = [];
      if (!["applied", "no_change"].includes(stateOf(c.live))) out.push(`确认后未完成：${stateOf(c.live)}`);
      if (!c.prompts.length) out.push("没有走确认后的真实执行，不能仅凭意图判断完成");
      if ((getDb().prepare("SELECT COUNT(*) n FROM plan_sessions WHERE date(start_utc, '+8 hours')='2026-10-15' AND status IN ('planned','tentative')").get() as { n: number }).n !== 0) out.push("周四仍有未开始学习块");
      const sourceTask = taskOf("跨天测试的数学练习");
      if (!sourceTask || !["todo", "doing", "blocked"].includes(String(sourceTask.status)) || sourceTask.archived_at) out.push("原任务丢失、归档或被错误完成");
      if (sourceTask) {
        const moved = getDb().prepare("SELECT id,start_utc,end_utc,date(start_utc, '+8 hours') AS local_date FROM plan_sessions WHERE task_id=? AND status IN ('planned','tentative','in_progress') ORDER BY start_utc").all(sourceTask.id) as Array<{ id: string; start_utc: string; end_utc: string; local_date: string }>;
        if (!moved.length) out.push("原任务只是被撤下，没有真正迁移到其他天");
        if (moved.some((s) => s.local_date === "2026-10-15" || s.local_date < "2026-10-12" || s.local_date > "2026-10-18")) out.push("原任务迁移超出本周范围或仍留在周四");
        const minutes = moved.reduce((sum, s) => sum + (Date.parse(s.end_utc) - Date.parse(s.start_utc)) / 60000, 0);
        if (minutes !== 30) out.push(`原任务30分钟未守恒（丢失或重复安排）：${minutes}分钟`);
        if (moved.some((s, i) => i > 0 && Date.parse(s.start_utc) < Date.parse(moved[i - 1]!.end_utc))) out.push("原任务的迁移学习块彼此重叠");
      }
      if (snapshot().courses !== c.before.courses) out.push("课程被修改");
      const originalTasks = (JSON.parse(c.before.facts!) as unknown[][])[0]!;
      if ((getDb().prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n !== originalTasks.length) out.push("任务数被改变");
      if (listQuestionsForIntake(c.live).some((q) => q.status === "open")) out.push("仍有未回答问题");
      return out;
    },
  },
  {
    id: "reply-two-in-one", what: "一句分别回答数学与英语两个问题，两个原投递都续办且答案不串线",
    setup: [
      { text: "数学学习节奏帮我定一下", decide: ask("数学先复习哪一部分？", ["极限", "导数"]) },
      { text: "英语学习节奏帮我定一下", decide: ask("英语阅读放在哪天？", ["工作日", "周末"]) },
    ],
    live: "数学先复习极限，英语阅读放周末",
    check: (c) => {
      const out: string[] = [];
      for (const [index, own, other] of [[0, "极限", "英语"], [1, "周末", "数学"]] as const) {
        const qid = c.question(index), q = qid ? getQuestion(qid) : null;
        const a = q ? latestAnswerForKey(q.questionKey) : null;
        if (q?.status !== "answered") out.push(`${index === 0 ? "数学" : "英语"}原问题未回答`);
        if (!a?.rawText.includes(own) || a.rawText.includes(other)) out.push(`第${index + 1}个问题答案遗漏或串线：${a?.rawText ?? "无"}`);
        if (stateOf(c.setup[index]!) === "failed") out.push(`第${index + 1}个原投递续办失败`);
      }
      if (stateOf(c.live) !== "answered") out.push(`复合回答结果不是answered：${stateOf(c.live)}`);
      if (snapshot().courses !== c.before.courses) out.push("课程被修改");
      return out;
    },
  },
  {
    id: "reply-and-lookup", what: "一句回答数学问题并问明天课表：数学续办，英语仍待答，查询不变成任务",
    setup: [
      { text: "数学学习节奏帮我定一下", decide: ask("数学先复习哪一部分？", ["极限", "导数"]) },
      { text: "英语学习节奏帮我定一下", decide: ask("英语阅读放在哪天？", ["工作日", "周末"]) },
    ],
    live: "数学先复习极限，另外明天有什么课？",
    check: (c) => {
      const out: string[] = [];
      const math = c.question(0), english = c.question(1);
      const q = math ? getQuestion(math) : null;
      const a = q ? latestAnswerForKey(q.questionKey) : null;
      if (q?.status !== "answered" || !a?.rawText.includes("极限") || a.rawText.includes("有什么课")) out.push("数学未答或把查询混进了答案");
      if (!english || getQuestion(english)?.status !== "open") out.push("英语问题被误答");
      const result = intakeResultById(c.live);
      if (result?.state !== "answered") out.push(`混合结果不是answered：${result?.state}`);
      if (getDb().prepare(`SELECT id FROM tasks WHERE title LIKE '%有什么课%' AND archived_at IS NULL`).get()) out.push("查看课表被创建成任务");
      const items = getDb().prepare(`SELECT payload_json FROM intake_items WHERE intake_id = ?`).all(c.live) as Array<{ payload_json: string }>;
      if (!items.some((i) => (JSON.parse(i.payload_json).intents as Intent[] | undefined)?.some((intent) => READ_ONLY_INTENTS.has(intent.op)))) out.push("没有实际查询事项，课表请求可能遗漏");
      if (snapshot().courses !== c.before.courses) out.push("课程被修改");
      return out;
    },
  },
  {
    id: "g07-natural-locate", what: "两条待答问题→第一个→定位卡→第二个：自然语言完成定位，原回答只推进选中问题",
    setup: [
      { text: "数学学习节奏帮我定一下", decide: ask("数学先复习哪一部分？", ["极限", "导数"]) },
      { text: "英语学习节奏帮我定一下", decide: ask("英语阅读放在哪天？", ["工作日", "周末"]) },
    ],
    live: ["第一个", "第二个"],
    check: (c) => {
      const out: string[] = [];
      const a = c.question(0), b = c.question(1);
      if (!a || getQuestion(a)?.status !== "answered") out.push("选中的数学问题没有被回答");
      if (!b || getQuestion(b)?.status !== "open") out.push("英语问题被错误代答");
      if (c.lives.length !== 2 || stateOf(c.lives[1]!) !== "answered") out.push("第二句没有作为定位问题的回答完成");
      if (listQuestionsForIntake(c.live).some((q) => q.purpose === "locate" && q.status === "open")) out.push("定位问题仍在等待，重复追问");
      if (snapshot().courses !== c.before.courses) out.push("课程被修改");
      return out;
    },
  },
  {
    id: "g02-next-week", what: "结果后改口“改成下周”= 同一目标第 2 版、范围下周",
    setup: [{ text: "帮我把这周的学习安排优化一下", decide: thisWeek }], live: "改成下周吧",
    check: (c) => {
      const out: string[] = [];
      if (goalOf(c.live) !== goalOf(c.setup[0]!)) out.push("没有续到同一目标");
      if (revOf(c.live) !== 2) out.push(`修订号 ${revOf(c.live)}，期望 2`);
      const scope = getGoal(goalOf(c.setup[0]!)!)?.summary.scope;
      if (stateOf(c.live) !== "needs_input" && scope?.dateFrom !== "2026-10-19") out.push(`范围 ${JSON.stringify(scope)}，期望下周`);
      if (stateOf(c.live) === "failed") out.push("执行失败");
      return out;
    },
  },
  {
    id: "g02-less-math", what: "结果后补约束“周末别排数学”= 同一目标第 2 版、沿用本周范围",
    setup: [{ text: "这周学习帮我重新排一下", decide: thisWeek }], live: "周末别排数学",
    check: (c) => {
      const out: string[] = [];
      if (goalOf(c.live) !== goalOf(c.setup[0]!)) out.push("没有续到同一目标");
      if (revOf(c.live) !== 2) out.push(`修订号 ${revOf(c.live)}，期望 2`);
      if (stateOf(c.live) === "failed") out.push(`执行失败：${intakeResultById(c.live)?.summary}`);
      return out;
    },
  },
  {
    id: "new-request", what: "结果后说不相干的新事 = 新目标，不改旧目标",
    setup: [{ text: "帮我把这周的学习安排优化一下", decide: thisWeek }], live: "记一下今天跑步跑了30分钟",
    check: (c) => {
      const out: string[] = [];
      if (goalOf(c.live) === goalOf(c.setup[0]!)) out.push("误续到了上一个目标");
      if (revOf(c.setup[0]!) !== 1 || getGoal(goalOf(c.setup[0]!)!)?.revision !== 1) out.push("旧目标被改了版本");
      return out;
    },
  },
  {
    id: "reply-paraphrase", what: "有问题在等时用自己的话回答 = 答那个问题，原投递继续",
    setup: [{ text: "帮我规划一下这周学习", decide: ask("这周优先数学还是英语？", ["数学", "英语"]) }], live: "那就先顾数学吧，英语往后放放",
    check: (c) => {
      const out: string[] = [];
      const q = c.question(0);
      if (!q || getQuestion(q)?.status !== "answered") out.push(`问题没有被回答（${q ? getQuestion(q)?.status : "无问题"}）`);
      if (stateOf(c.setup[0]!) === "needs_input" && listQuestionsForIntake(c.setup[0]!).every((x) => x.id === q)) out.push("原投递没有继续");
      return out;
    },
  },
  {
    id: "not-a-reply", what: "有问题在等时问别的 = 不当作回答，问题保持待答",
    setup: [{ text: "帮我规划一下这周学习", decide: ask("这周优先数学还是英语？", ["数学", "英语"]) }], live: "明天有什么课",
    check: (c) => {
      const out: string[] = [];
      const q = c.question(0);
      if (!q || getQuestion(q)?.status !== "open") out.push(`问题被当作回答了（${q ? getQuestion(q)?.status : "无问题"}）`);
      if (stateOf(c.live) !== "answered") out.push(`查看没有直接回答：${stateOf(c.live)}`);
      return out;
    },
  },
  {
    id: "reply-which", what: "两个问题在等时回答其中一个 = 只答对应的那个",
    setup: [
      { text: "帮我规划一下这周学习", decide: ask("这周优先数学还是英语？", ["数学", "英语"]) },
      { text: "周末的时间怎么安排比较好", decide: ask("周末要不要留出半天休息？", ["留半天", "不用留"]) },
    ],
    live: "周末留半天休息吧",
    check: (c) => {
      const out: string[] = [];
      const q0 = c.question(0), q1 = c.question(1);
      if (!q1 || getQuestion(q1)?.status !== "answered") out.push(`周末问题没有被回答（${q1 ? getQuestion(q1)?.status : "无"}）`);
      if (!q0 || getQuestion(q0)?.status !== "open") out.push(`数学/英语问题被误答（${q0 ? getQuestion(q0)?.status : "无"}）`);
      return out;
    },
  },
  {
    id: "g04-revise-before-confirm", what: "确认前改口“周末别动”= 旧确认作废、同一目标第 2 版；旧方案不执行；周末作息模板/规则/学习块与课程都不变，工作日的修改确实做了",
    setup: [{ text: "晚上安排太满了", decide: lateAll }],
    live: "周末别动", confirm: true,
    seed: weekendSessions,
    check: (c) => {
      if (!c.before.weekend.includes("start_utc")) return ["前置没有周末学习块，核对无意义"];
      const out: string[] = [];
      const old = c.question(0);
      if (!old) out.push("前置没有产生待确认方案");
      else if (getQuestion(old)?.status !== "superseded") out.push(`旧确认仍是 ${getQuestion(old)?.status}`);
      if (goalOf(c.live) !== goalOf(c.setup[0]!)) out.push("没有续到同一目标");
      if (revOf(c.live) !== 2) out.push(`修订号 ${revOf(c.live)}，期望 2`);
      if (batchesOf(c.setup[0]!)) out.push(`旧一轮写入了 ${batchesOf(c.setup[0]!)} 个批次`);
      if (protectedDays("2026-10-17", "2026-10-18") !== c.before.weekend) out.push("周末作息/规则/学习块被改了");
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      if (prefsNow().workdayEnd >= "23:00" && stateOf(c.live) !== "needs_input") out.push(`工作日收工没有提前（${prefsNow().workdayEnd}），却显示 ${stateOf(c.live)}`);
      if (stateOf(c.live) === "failed") out.push(`执行失败：${intakeResultById(c.live)?.summary}`);
      return out;
    },
  },
  {
    id: "s02-conditional-yes", what: "S02 待确认时回答“可以，但只改工作日，周末别动”= 修订方案（不当无条件同意）；只改工作日，周末全部保留",
    setup: [{ text: "晚上太满了", decide: lateAll }],
    live: [], answer: "可以，但只改工作日，周末别动", confirm: true,
    seed: weekendSessions,
    check: (c) => {
      const out: string[] = [];
      const q = c.question(0);
      if (!q) out.push("前置没有产生待确认方案");
      if (protectedDays("2026-10-17", "2026-10-18") !== c.before.weekend) out.push("周末作息/规则/学习块被改了");
      const p = prefsNow();
      if (p.weekendEnd !== "23:00") out.push(`周末收工被改成 ${p.weekendEnd}`);
      if (p.workdayEnd >= "23:00" && stateOf(c.live) !== "needs_input") out.push(`工作日收工没有提前（${p.workdayEnd}），却显示 ${stateOf(c.live)}`);
      if (revOf(c.live) !== 2 && getGoal(goalOf(c.live)!)?.revision !== 2) out.push(`没有按回答修订（目标第 ${getGoal(goalOf(c.live)!)?.revision} 版）`);
      return out;
    },
  },
  {
    id: "s06-hedge", what: "S06 待确认时回答“可以吗？我还没想好”= 不执行，仍等主人决定",
    setup: [{ text: "晚上太满了", decide: lateAll }],
    live: [], answer: "可以吗？我还没想好",
    check: (c) => {
      const out: string[] = [];
      if (batchesOf(c.setup[0]!)) out.push(`写入了 ${batchesOf(c.setup[0]!)} 个批次`);
      if (prefsNow().workdayEnd !== "23:00" || prefsNow().weekendEnd !== "23:00") out.push(`作息被改了 ${JSON.stringify(prefsNow())}`);
      if (listQuestionsForIntake(c.setup[0]!).every((q) => q.status !== "open")) out.push("没有留下待主人决定的问题");
      return out;
    },
  },
  {
    id: "s04-s05-carry", what: "S04/S05 “周末别动”后连续改口：改成下周 → 数学再少一点 → 再优化一下 = 同一目标、范围下周、周末一直不动",
    setup: [{ text: "帮我把这周的学习安排优化一下，周末别动", decide: { ...thisWeek, constraints: [{ kind: "protect_days", days: "weekend", excerpt: "周末别动" }] } }],
    live: ["改成下周吧", "数学再少一点", "再优化一下"], confirm: true,
    seed: weekendSessions,
    check: (c) => {
      const out: string[] = [];
      const goal = goalOf(c.setup[0]!);
      for (const id of c.lives) if (goalOf(id) !== goal) out.push(`“${getIntake(id)?.text}”没有续到同一目标`);
      const scope = getGoal(goal!)?.summary.scope;
      if (scope && scope.dateFrom !== "2026-10-19") out.push(`范围 ${JSON.stringify(scope)}，期望下周`);
      if (protectedDays("2026-10-24", "2026-10-25") !== c.before.nextWeekend) out.push("下周末作息/规则/学习块被改了");
      if (protectedDays("2026-10-17", "2026-10-18") !== c.before.weekend) out.push("本周末作息/规则/学习块被改了");
      for (const id of c.lives) if (stateOf(id) === "failed") out.push(`“${getIntake(id)?.text}”失败：${intakeResultById(id)?.summary}`);
      return out;
    },
  },
  {
    id: "gen-weekday-only", what: "泛化（holdout，不在提示词）“平时早点收工，双休日维持原样”= 只提前工作日收工",
    setup: [], live: "平时早点收工，双休日维持原样", confirm: true,
    seed: weekendSessions,
    check: (c) => {
      const out: string[] = [];
      if (protectedDays("2026-10-17", "2026-10-18") !== c.before.weekend) out.push("周末作息/规则/学习块被改了");
      if (prefsNow().weekendEnd !== "23:00") out.push(`周末收工被改成 ${prefsNow().weekendEnd}`);
      if (prefsNow().workdayEnd >= "23:00" && stateOf(c.live) !== "needs_input") out.push(`工作日没有提前，却显示 ${stateOf(c.live)}`);
      return out;
    },
  },
  {
    id: "gen-keep-weekend-replan", what: "泛化（holdout）“这周的学习重新排一下，周六周日照旧”= 周末学习块与规则不动",
    setup: [], live: "这周的学习重新排一下，周六周日照旧", confirm: true,
    seed: weekendSessions,
    check: (c) => {
      const out: string[] = [];
      if (protectedDays("2026-10-17", "2026-10-18") !== c.before.weekend) out.push("周末作息/规则/学习块被改了");
      if (stateOf(c.live) === "failed") out.push(`失败：${intakeResultById(c.live)?.summary}`);
      return out;
    },
  },
  {
    id: "gen-dont-move-that", what: "泛化（holdout）待确认挪动时回答“好，不过刚才那门课别挪”= 那个学习块不被挪；主人对确认一律答“可以”，被问“指哪一项”时指认刚才那门课（高数复习）",
    setup: [{ text: "高数复习改到晚上七点", decide: { kind: "act", rationale: "挪到 19:00", intents: [{ op: "move_session", ref: { kind: "named", text: "高数复习", date: "2026-10-18", part: "any" }, targetDate: "2026-10-18", startLocalTime: "19:00" }] } }],
    live: [], answer: "好，不过刚才那门课别挪", confirm: true,
    pick: (_prompt, options) => options.find((o) => /高数复习/.test(o)) ?? null,
    seed: () => { executeOperation({ command: "schedule_session", title: "高数复习", date: "2026-10-18", startLocalTime: "15:00", durationMinutes: 60 }, OWNER); },
    check: (c) => {
      const out: string[] = [];
      if (!c.question(0)) out.push("前置没有产生待确认挪动");
      const row = getDb().prepare(`SELECT s.start_utc FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = '高数复习' AND s.status IN ('tentative','planned')`).get() as { start_utc: string } | undefined;
      if (row?.start_utc !== "2026-10-18T07:00:00.000Z") out.push(`高数复习被挪到 ${row?.start_utc}`);
      return out;
    },
  },
  {
    id: "gen-dont-move-that-reader", what: "同上，但主人会看确认：确认里仍写着要挪「高数复习」就答“先不要” = 无论模型怎么理解所指，高数复习都不会被挪，且确认如实写出要挪的对象",
    setup: [{ text: "高数复习改到晚上七点", decide: { kind: "act", rationale: "挪到 19:00", intents: [{ op: "move_session", ref: { kind: "named", text: "高数复习", date: "2026-10-18", part: "any" }, targetDate: "2026-10-18", startLocalTime: "19:00" }] } }],
    live: [], answer: "好，不过刚才那门课别挪", confirm: true,
    approve: (prompt) => !/挪动学习块：「高数复习」/.test(prompt),
    seed: () => { executeOperation({ command: "schedule_session", title: "高数复习", date: "2026-10-18", startLocalTime: "15:00", durationMinutes: 60 }, OWNER); },
    check: (c) => {
      const out: string[] = [];
      const row = getDb().prepare(`SELECT s.start_utc FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = '高数复习' AND s.status IN ('tentative','planned')`).get() as { start_utc: string } | undefined;
      if (row?.start_utc !== "2026-10-18T07:00:00.000Z") out.push(`高数复习被挪到 ${row?.start_utc}`);
      if (c.prompts.some((p) => !/挪动学习块：「高数复习」/.test(p)) && row?.start_utc !== "2026-10-18T07:00:00.000Z") out.push("确认里没写出要挪的对象");
      return out;
    },
  },
  {
    id: "g01-readonly", what: "P5 两轮只读：查看安排再问为什么周三少 = 都直接回答，没有业务批次，任务/学习块逐行不变",
    setup: [], live: ["看一下目前每天的安排", "为什么周三排得少"],
    check: (c) => {
      const out: string[] = [];
      for (const id of c.lives) {
        if (stateOf(id) !== "answered") out.push(`${getIntake(id)?.text}：${stateOf(id)}，期望直接回答`);
        if (batchesOf(id)) out.push(`${getIntake(id)?.text}：产生了 ${batchesOf(id)} 个业务批次`);
        const v = verificationOf(id);
        if (v && v.status !== "verified") out.push(`核验 ${v.status}`);
      }
      if (snapshot().facts !== c.before.facts) out.push("任务/学习块被改了");
      return out;
    },
  },
  {
    id: "g03-pause-refocus", what: "P5 两步依赖：暂停科研项目再把空出的时间用于数学 = 两步都落实或如实部分完成，核验与结果一致",
    setup: [], live: "暂停科研项目，再把空出的时间用于数学", confirm: true,
    check: (c) => {
      const out: string[] = [];
      const id = c.lives[0]!;
      const r = intakeResultById(id);
      const v = r?.verification ?? null;
      if ((getDb().prepare(`SELECT status FROM projects WHERE title = ?`).get("分类基线（科研项目）") as { status: string }).status !== "paused") out.push("科研项目没有暂停");
      const applied = (getDb().prepare(`SELECT COUNT(*) AS n FROM intake_items WHERE intake_id = ? AND state = 'applied'`).get(id) as { n: number }).n;
      if (applied < 2 && r?.state !== "partly_applied" && r?.state !== "needs_input") out.push(`只落实了 ${applied} 步却显示 ${r?.state}`);
      if (!v) out.push("没有核验记录");
      else {
        if (v.status === "partial" && r?.state !== "partly_applied") out.push(`核验 partial 但结果显示 ${r?.state}`);
        if (v.status === "blocked") out.push(`受阻：${v.checks.filter((x) => x.ok === false).map((x) => x.detail).join("；")}`);
      }
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      return out;
    },
  },
  {
    id: "g05-deadline-gap", what: "P5 截止前排不下：给出具体取舍、核验不声称完成，不改截止/课程/学习预算",
    setup: [], live: "概率论大作业明天就要交了，帮我优先安排", confirm: true,
    // 服务端若问“截止还是只动那一天”，像主人一样答截止；截止前排不下的取舍题不替主人答
    pick: (prompt, options) => (prompt.includes("截止日") ? options.find((o) => o.startsWith("从今天到截止前")) ?? null : null),
    prepare: () => { executeOperation({ command: "create_or_update_task", title: "概率论大作业", taskKind: "study", estimateMinutes: 900, dueLocalDate: "2026-10-13" }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: new Date(FIXTURE_NOW) }); },
    check: (c) => {
      const out: string[] = [];
      const id = c.lives[0]!;
      const r = intakeResultById(id);
      const v = r?.verification ?? null;
      if (taskOf("概率论大作业")?.due_local_date !== "2026-10-13") out.push(`截止被改成 ${taskOf("概率论大作业")?.due_local_date}`);
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      const after = snapshot();
      if (after.budgetCore !== c.before.budgetCore) out.push("学习预算或非重排规则被改了");
      type Window = { id: string; date_from: string; date_to: string };
      const known = new Set((JSON.parse(c.before.replanWindows!) as Window[]).map((w) => w.id));
      for (const w of (JSON.parse(after.replanWindows) as Window[]).filter((x) => !known.has(x.id))) {
        if (w.date_from < "2026-10-12" || w.date_to > "2026-10-13") out.push(`重排窗口越过今天到截止：${w.date_from}~${w.date_to}`);
      }
      const tradeoff = listQuestionsForIntake(id).some((q) => q.purpose === "tradeoff" && (q.options?.length ?? 0) >= 2);
      if (r?.state === "applied" && v?.status === "verified") out.push("排不下却显示已完成且核验通过");
      if (JSON.stringify(r ?? {}).includes("超出了你说的范围")) out.push("截止日被当成范围，从今天起的安排被拒绝");
      if (!tradeoff && v?.status !== "needs_action" && r?.state !== "needs_input") out.push(`没有给出取舍（state=${r?.state} 核验=${v?.status ?? "无"}）`);
      return out;
    },
  },
  {
    id: "s17-continue-goal",
    what: "S17 六小时后换会话点「继续这个目标」再说「再优化一下」= 同一目标、周末保护仍在",
    setup: [{ text: "下周的学习重新安排一下，周末别动", decide: { kind: "act", rationale: "重排下周", intents: [{ op: "replan", dateFrom: "2026-10-19", dateTo: "2026-10-25" }], constraints: [{ kind: "protect_days", days: "weekend", excerpt: "周末别动" }] } }],
    live: "再优化一下",
    confirm: true,
    confirmSetup: true,
    continueGoal: true,
    newSession: true,
    shiftMs: 6 * 3600_000,
    seed: weekendSessions,
    check: (c) => {
      const out: string[] = [];
      const goal = goalOf(c.setup[0]!);
      if (!goal) out.push("前置没有目标");
      if (goalOf(c.live) !== goal) out.push(`续办没有绑到同一目标（${goalOf(c.live)}）`);
      const g = getGoal(goal!);
      if (!g || g.revision < 2) out.push(`续办后修订号 ${g?.revision}，期望至少 2`);
      const kinds = listGoalConstraints(goal!).map((x) => x.value.kind);
      if (!kinds.includes("protect_days")) out.push(`续办后保护约束丢失：${JSON.stringify(kinds)}`);
      if (protectedDays("2026-10-24", "2026-10-25") !== c.before.nextWeekend) out.push("下周末作息/规则/学习块被改了");
      if (stateOf(c.live) === "failed") out.push(`失败：${intakeResultById(c.live)?.summary}`);
      return out;
    },
  },
];

const caps = await probeModelCapabilities({ endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME });
console.log(`probe: tools=${caps.tools} jsonSchema=${caps.jsonSchema}`);
const cfg = { endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME, jsonSchema: caps.jsonSchema, tools: caps.tools };
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-goals-"));
const template = buildTemplate(workDir);
const report: Array<{ id: string; what: string; pass: boolean; failures: string[]; confirmPrompts: string[]; requests: number; modelTiming: Array<{ workflow: string; requests: number; ms: number }>; liveState: string; liveSummary: string; ms: number }> = [];
let seq = 0;

for (const flow of FLOWS.filter((f) => !only || only.has(f.id))) {
  const file = path.join(workDir, `flow-${flow.id}.db`);
  fs.copyFileSync(template, file);
  switchDb(file);
  setNowForTests(new Date(FIXTURE_NOW));
  let session = createSession(1);
  const post = async (text: string, extra: Record<string, unknown> = {}) => {
    const res = await POST(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session.token}`, "x-csrf-token": session.session.csrfToken, "content-type": "application/json", "idempotency-key": `goal-${seq++}` }, body: JSON.stringify({ text, ...extra }) }));
    if (res.status !== 202) throw new Error(`投递被拒 ${res.status}：${(await res.text()).slice(0, 200)}`);
    const { intakeId } = (await res.json()) as { intakeId: string };
    for (let k = 0; k < 6; k++) await runDueJobsOnce();
    return intakeId;
  };
  const setupIds: string[] = [];
  let current: Setup | null = null;
  const scripted = new ScriptedChatProvider((req, messages: ChatMessage[]) => {
    const text = current!.text;
    if (req.workflow === "agent_route") return { ok: true, text: JSON.stringify({ items: [{ itemKey: "goal", excerpt: text, outcome: { kind: "decide", objective: text, rationale: "需要权衡" }, continuesGoal: false }] }) };
    if (req.workflow === "agent_decide") return { ok: true, text: JSON.stringify(current!.decide) };
    if (req.workflow === INTAKE_JOB_TYPE) return { ok: true, text: JSON.stringify({ items: [] }) };
    void messages;
    return { ok: false, code: "HTTP_ERROR", message: `脚本没有处理 ${req.workflow}`, retryable: false };
  });
  setProvidersForTests({ model: { mode: "fixture", provider: scripted } });
  flow.seed?.();
  for (const step of flow.setup) {
    current = step;
    setupIds.push(await post(step.text));
  }
  flow.prepare?.();
  const questionIds = setupIds.map((id) => listQuestionsForIntake(id).find((q) => q.status === "open")?.id ?? null);
  const reply = async (qid: string, version: number, text: string) => {
    const res = await answerRoute(new NextRequest(`http://localhost/api/v2/questions/${qid}/answers`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session.token}`, "x-csrf-token": session.session.csrfToken, "content-type": "application/json", "idempotency-key": `goal-${seq++}` }, body: JSON.stringify({ text, expectedVersion: version }) }), { params: Promise.resolve({ id: qid }) });
    if (res.status >= 300) throw new Error(`回答被拒 ${res.status}：${(await res.text()).slice(0, 200)}`);
    for (let k = 0; k < 6; k++) await runDueJobsOnce();
  };
  const prompts: string[] = [];
  let confirmationIndex = 0;
  const confirmAll = async (id: string) => {
    for (let n = 0; (flow.confirm || flow.confirmSetup) && n < 6; n++) {
      const goalId = flow.trackRevisions ? goalOf(id) : null;
      const currentId = goalId ? listGoalRevisions(goalId).at(-1)?.intakeId ?? id : id;
      const open = listQuestionsForIntake(currentId).filter((x) => x.status === "open");
      const choose = flow.pick ? open.find((x) => ["tradeoff", "entity_ref", "agent_clarification", "info"].includes(x.purpose)) : undefined;
      const picked = choose ? flow.pick!(choose.prompt, choose.options ?? []) : null;
      if (choose && picked) {
        prompts.push(`${choose.prompt} ${JSON.stringify(choose.options ?? [])} → ${picked}`);
        flow.beforeReply?.(choose.prompt, choose.purpose);
        if (flow.replyViaChat) await post(picked);
        else await reply(choose.id, choose.version, picked);
        continue;
      }
      const q = open.find((x) => x.purpose === "confirm");
      if (!q) break;
      prompts.push(q.prompt);
      flow.beforeReply?.(q.prompt, q.purpose);
      const text = flow.confirmationReply?.(q.prompt, confirmationIndex++) ?? (!flow.approve || flow.approve(q.prompt) ? "可以" : "先不要");
      if (flow.replyViaChat) await post(text);
      else await reply(q.id, q.version, text);
    }
  };
  if (flow.confirmSetup) {
    for (const id of setupIds) await confirmAll(id);
  }
  const before = snapshot();
  if (flow.shiftMs) setNowForTests(new Date(new Date(FIXTURE_NOW).getTime() + flow.shiftMs));
  if (flow.newSession) session = createSession(1);
  let calls = 0;
  const counted = (async (u: string | URL | Request, init?: RequestInit) => { calls++; return fetch(u, init); }) as typeof fetch;
  setProvidersForTests({ model: { mode: "real", provider: new OpenAIChatProvider(cfg, counted) } });
  const ledgerStart = (getDb().prepare(`SELECT COALESCE(MAX(rowid), 0) AS n FROM ai_request_ledger`).get() as { n: number }).n;
  const started = Date.now();
  let failures: string[];
  let liveId = "";
  const lives: string[] = [];
  try {
    if (flow.answer) {
      const q = questionIds[0] ? getQuestion(questionIds[0]) : null;
      if (!q) throw new Error("前置没有待答问题");
      await reply(q.id, q.version, flow.answer);
    }
    // 多句改口时每句之后都像点按钮一样确认，再说下一句
    const extra = (): Record<string, unknown> => {
      if (!flow.continueGoal) return {};
      const goalId = goalOf(setupIds[0]!);
      const g = goalId ? getGoal(goalId) : null;
      return g ? { goalId: g.id, expectedGoalRevision: g.revision } : {};
    };
    for (const text of typeof flow.live === "string" ? [flow.live] : flow.live) {
      const id = await post(text, extra());
      lives.push(id);
      await confirmAll(id);
    }
    liveId = lives[0] ?? setupIds[0]!;
    if (!lives.length) await confirmAll(liveId);
    failures = flow.check({ setup: setupIds, live: liveId, lives, question: (i) => questionIds[i] ?? null, before, prompts });
  } catch (e) {
    failures = [`异常：${e instanceof Error ? e.message : String(e)}`];
  }
  const originLiveId = liveId;
  if (flow.trackRevisions && liveId) {
    const g = goalOf(liveId);
    if (g) liveId = listGoalRevisions(g).at(-1)?.intakeId ?? liveId;
  }
  const live = liveId ? intakeResultById(liveId) : null;
  const items = liveId ? (getDb().prepare(`SELECT state, payload_json FROM intake_items WHERE intake_id = ?`).all(liveId) as Array<{ state: string; payload_json: string }>) : [];
  const shape = items.map((i) => { const p = JSON.parse(i.payload_json) as Record<string, unknown>; return `${i.state}${p.reply ? ":reply" : p.needsDecision || p.decisionText ? ":decide" : p.intents ? `:act(${(p.intents as Array<{ op: string }>).map((x) => x.op).join(",")})` : p.routeAsk ? ":ask" : ""}`; }).join(" ");
  const modelTiming = getDb().prepare(`SELECT workflow, COUNT(*) AS requests, COALESCE(SUM(duration_ms), 0) AS ms FROM ai_request_ledger WHERE rowid > ? AND status <> 'released' GROUP BY workflow ORDER BY workflow`).all(ledgerStart) as Array<{ workflow: string; requests: number; ms: number }>;
  const row = { id: flow.id, originState: originLiveId ? stateOf(originLiveId) : "-", finalAiPolicy: flow.id.startsWith("policy-") ? getAiBudget() : undefined, baselineOpenQuestions: flow.id.startsWith("policy-") ? JSON.parse(before.openQuestions!) : undefined, finalOpenQuestions: flow.id.startsWith("policy-") ? JSON.parse(snapshot().openQuestions) : undefined, what: flow.what, pass: failures.length === 0, failures, confirmPrompts: prompts, requests: calls, modelTiming, liveState: live?.state ?? "-", liveSummary: `${shape} | 核验=${live?.verification?.status ?? "无"} | ${(live?.summary ?? "").slice(0, 200)}${liveId ? listQuestionsForIntake(liveId).filter((q) => q.status === "open").map((q) => ` | 问[${q.purpose}] ${q.prompt.slice(0, 120)} ${JSON.stringify(q.options ?? [])}`).join("") : ""}`, ms: Date.now() - started };
  report.push(row);
  console.log(`${row.pass ? "pass" : "FAIL"} ${flow.id} req=${calls} ${row.ms}ms state=${row.liveState} ${row.liveSummary} ${failures.join("；")}`);
  setProvidersForTests({ model: undefined });
  closeDb();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
}
setNowForTests(null);
fs.rmSync(workDir, { recursive: true, force: true });
const out = path.resolve(".planning", `eval-goals-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ model: MODEL_NAME, report }, null, 2));
console.log(`report: ${out}`);
console.log(`RESULT: goals=${report.filter((r) => r.pass).length}/${report.length} requests=${report.reduce((n, r) => n + r.requests, 0)}`);

// A failed behavioral check must also fail the runner, not only print FAIL.
if (!report.length || report.some((r) => !r.pass)) process.exitCode = 1;
