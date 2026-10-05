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
import { getQuestion, listQuestionsForIntake } from "../src/repositories/questions";
import { getIntake } from "../src/repositories/intakes";
import { getGoal } from "../src/repositories/goals";
import { INTAKE_JOB_TYPE } from "../src/contracts/intake";
import { executeOperation } from "../src/workflows/commands";
import type { ChatMessage } from "../src/integrations/model-json";

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
type Flow = { id: string; what: string; setup: Setup[]; live: string | string[]; answer?: string; confirm?: boolean; approve?: (prompt: string) => boolean; pick?: (prompt: string, options: string[]) => string | null; seed?: () => void; prepare?: () => void; check: (c: Ctx) => string[] };

const thisWeek = { kind: "act", rationale: "按课程与预算重排本周剩余时间", intents: [{ op: "replan", dateFrom: "2026-10-12", dateTo: "2026-10-18" }] };
const ask = (question: string, options: string[]) => ({ kind: "ask", question, reason: "几种安排差别明显", options });

const snapshot = () => {
  const db = getDb();
  return {
    facts: JSON.stringify([db.prepare(`SELECT id, status, version, priority, paused_until, due_local_date FROM tasks ORDER BY id`).all(), db.prepare(`SELECT id, start_utc, status, version, locked FROM plan_sessions ORDER BY id`).all()]),
    courses: JSON.stringify(db.prepare(`SELECT * FROM courses ORDER BY id`).all()),
    budget: JSON.stringify([db.prepare(`SELECT * FROM planning_policy_rules ORDER BY id`).all(), db.prepare(`SELECT * FROM planning_preferences`).all()]),
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

const FLOWS: Flow[] = [
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
    prepare: () => { executeOperation({ command: "create_or_update_task", title: "概率论大作业", taskKind: "study", estimateMinutes: 900, dueLocalDate: "2026-10-13" }, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "", explicit: true, now: new Date(FIXTURE_NOW) }); },
    check: (c) => {
      const out: string[] = [];
      const id = c.lives[0]!;
      const r = intakeResultById(id);
      const v = r?.verification ?? null;
      if (taskOf("概率论大作业")?.due_local_date !== "2026-10-13") out.push(`截止被改成 ${taskOf("概率论大作业")?.due_local_date}`);
      if (snapshot().courses !== c.before.courses) out.push("课程被改了");
      if (snapshot().budget !== c.before.budget) out.push("规则或学习预算被改了");
      const tradeoff = listQuestionsForIntake(id).some((q) => q.purpose === "tradeoff" && (q.options?.length ?? 0) >= 2);
      if (r?.state === "applied" && v?.status === "verified") out.push("排不下却显示已完成且核验通过");
      if (!tradeoff && v?.status !== "needs_action" && r?.state !== "needs_input") out.push(`没有给出取舍（state=${r?.state} 核验=${v?.status ?? "无"}）`);
      return out;
    },
  },
];

const caps = await probeModelCapabilities({ endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME });
console.log(`probe: tools=${caps.tools} jsonSchema=${caps.jsonSchema}`);
const cfg = { endpoint: MODEL_ENDPOINT, apiKey: MODEL_API_KEY, model: MODEL_NAME, jsonSchema: caps.jsonSchema, tools: caps.tools };
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-goals-"));
const template = buildTemplate(workDir);
const report: Array<{ id: string; what: string; pass: boolean; failures: string[]; confirmPrompts: string[]; requests: number; liveState: string; liveSummary: string; ms: number }> = [];
let seq = 0;

for (const flow of FLOWS.filter((f) => !only || only.has(f.id))) {
  const file = path.join(workDir, `flow-${flow.id}.db`);
  fs.copyFileSync(template, file);
  switchDb(file);
  setNowForTests(new Date(FIXTURE_NOW));
  const s = createSession(1);
  const post = async (text: string) => {
    const res = await POST(new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${s.token}`, "x-csrf-token": s.session.csrfToken, "content-type": "application/json", "idempotency-key": `goal-${seq++}` }, body: JSON.stringify({ text }) }));
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
  const before = snapshot();
  let calls = 0;
  const counted = (async (u: string | URL | Request, init?: RequestInit) => { calls++; return fetch(u, init); }) as typeof fetch;
  setProvidersForTests({ model: { mode: "real", provider: new OpenAIChatProvider(cfg, counted) } });
  const started = Date.now();
  let failures: string[];
  let liveId = "";
  const lives: string[] = [];
  const prompts: string[] = [];
  try {
    const reply = async (qid: string, version: number, text: string) => {
      const res = await answerRoute(new NextRequest(`http://localhost/api/v2/questions/${qid}/answers`, { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${s.token}`, "x-csrf-token": s.session.csrfToken, "content-type": "application/json", "idempotency-key": `goal-${seq++}` }, body: JSON.stringify({ text, expectedVersion: version }) }), { params: Promise.resolve({ id: qid }) });
      if (res.status >= 300) throw new Error(`回答被拒 ${res.status}：${(await res.text()).slice(0, 200)}`);
      for (let k = 0; k < 6; k++) await runDueJobsOnce();
    };
    if (flow.answer) {
      const q = questionIds[0] ? getQuestion(questionIds[0]) : null;
      if (!q) throw new Error("前置没有待答问题");
      await reply(q.id, q.version, flow.answer);
    }
    // 多句改口时每句之后都像点按钮一样确认，再说下一句
    const confirmAll = async (id: string) => {
      for (let n = 0; flow.confirm && n < 6; n++) {
        const open = listQuestionsForIntake(id).filter((x) => x.status === "open");
        const choose = flow.pick ? open.find((x) => x.purpose === "tradeoff") : undefined;
        const picked = choose ? flow.pick!(choose.prompt, choose.options ?? []) : null;
        if (choose && picked) {
          prompts.push(`${choose.prompt} ${JSON.stringify(choose.options ?? [])} → ${picked}`);
          await reply(choose.id, choose.version, picked);
          continue;
        }
        const q = open.find((x) => x.purpose === "confirm");
        if (!q) break;
        prompts.push(q.prompt);
        await reply(q.id, q.version, !flow.approve || flow.approve(q.prompt) ? "可以" : "先不要");
      }
    };
    for (const text of typeof flow.live === "string" ? [flow.live] : flow.live) {
      const id = await post(text);
      lives.push(id);
      await confirmAll(id);
    }
    liveId = lives[0] ?? setupIds[0]!;
    if (!lives.length) await confirmAll(liveId);
    failures = flow.check({ setup: setupIds, live: liveId, lives, question: (i) => questionIds[i] ?? null, before, prompts });
  } catch (e) {
    failures = [`异常：${e instanceof Error ? e.message : String(e)}`];
  }
  const live = liveId ? intakeResultById(liveId) : null;
  const items = liveId ? (getDb().prepare(`SELECT state, payload_json FROM intake_items WHERE intake_id = ?`).all(liveId) as Array<{ state: string; payload_json: string }>) : [];
  const shape = items.map((i) => { const p = JSON.parse(i.payload_json) as Record<string, unknown>; return `${i.state}${p.reply ? ":reply" : p.needsDecision || p.decisionText ? ":decide" : p.intents ? `:act(${(p.intents as Array<{ op: string }>).map((x) => x.op).join(",")})` : p.routeAsk ? ":ask" : ""}`; }).join(" ");
  const row = { id: flow.id, what: flow.what, pass: failures.length === 0, failures, confirmPrompts: prompts, requests: calls, liveState: live?.state ?? "-", liveSummary: `${shape} | 核验=${live?.verification?.status ?? "无"} | ${(live?.summary ?? "").slice(0, 200)}${liveId ? listQuestionsForIntake(liveId).filter((q) => q.status === "open").map((q) => ` | 问[${q.purpose}] ${q.prompt.slice(0, 120)} ${JSON.stringify(q.options ?? [])}`).join("") : ""}`, ms: Date.now() - started };
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
