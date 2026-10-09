import crypto from "node:crypto";
import { getConfig } from "@/config";
import { getDb } from "@/repositories/db";
import { addDays, instanceTimezone, localDateInTz, mondayOf } from "@/domain/time";
import { executeCommand } from "@/workflows/commands";
import { rebuildPlan } from "@/workflows/plan";
import { createProject } from "@/repositories/planning";
import { createLog } from "@/repositories/logs";
import { finishRun, insertCandidate, insertEvidence, insertRun, setRunStage } from "@/repositories/exploration";
import { finishReview, insertReview } from "@/repositories/reviews";
import { createSource } from "@/repositories/inbox";
import { latestNewsDigest } from "@/repositories/ai-news";
import { appendTurn, currentConversationId } from "@/repositories/conversations";
import { contentHash, evidenceHash } from "@/domain/exploration";
import { importVerifiedNotice } from "@/workflows/inbox";
import { translateProposals } from "@/workflows/ai-proposals";
import { hasRecords, weekFacts } from "@/workflows/week-facts";
import { AI_BUDGET_SETTINGS_KEY, aiBudgetSchema } from "@/contracts/review";
import type { CommandContext } from "@/contracts/commands";

/**
 * 演示库的合成示例数据：一位虚构的人工智能专业大二学生“示例同学”这学期第 6 周的样子。
 * - 全部是编出来的：课程、老师、地点、通知、资料链接（example.org）都不对应真实的人和学校；
 * - 日期都从“今天”推算：首周周一在五周前，任务截止、实践记录、固定活动围绕本周，哪天恢复都像是当周的数据；
 * - 业务对象一律走注册过的业务操作（和 Agent、按钮是同一条路），课表投影、提醒、变更记录由操作产生，学习块由同一个重排算法排出来，不是手写的行；
 *   只有模型产出的东西（探索候选、复盘、资讯、对话历史）没有调用模型，用写好的内容经仓储层放进去。
 * 由 resetDemoData 在一个事务里调用：任何一步失败整次恢复回滚，不会留下半份示例。
 */

/** 示例内容改了就加一：已部署的演示实例会在下一趟 worker 轮询时自动恢复成新版示例 */
export const DEMO_SEED_VERSION = 1;

const SDCT = [
  "SDCT1",
  "T=18",
  "P=1,08:00-08:45;2,08:55-09:40;3,10:00-10:45;4,10:55-11:40;5,14:00-14:45;6,14:55-15:40;7,16:00-16:45;8,16:55-17:40;9,19:00-19:45;10,19:55-20:40",
  "C=数据结构|陈老师|教三-204|1|1-2|1-18|A|-",
  "C=数据结构|陈老师|教三-204|3|3-4|1-18|A|-",
  "C=线性代数|李老师|教一-301|2|1-2|1-18|A|-",
  "C=线性代数|李老师|教一-301|4|3-4|1-18|A|-",
  "C=概率论与数理统计|王老师|教二-105|1|5-6|1-18|A|-",
  "C=概率论与数理统计|王老师|教二-105|4|5-6|1-18|O|-",
  "C=大学英语（三）|周老师|外语楼-412|2|5-6|1-18|A|-",
  "C=Python 程序设计实践|赵老师|实验楼-B203|3|7-8|1-18|A|-",
  "C=大学物理|刘老师|教一-108|5|1-2|1-18|A|-",
  "C=形势与政策|吴老师|教四-101|5|5-6|1-18|E|-",
  "C=体育（篮球）|孙老师|东区球场|4|7-8|1-18|A|-",
].join("\n");

/** 探索用的三段“粘贴资料”和由它们得到的三个候选；quote 必须是资料原文里的一段 */
const EXPLORE_QUERY = "想试试“让大模型应用更可靠”这类工作，有没有两周内能做完的小项目？";
const MATERIALS = [
  {
    title: "社团分享会笔记：课程答疑机器人常见的失败",
    text: "社团分享会笔记：我们给《数据结构》课做了一个答疑机器人。上线两周收集到的失败主要有三类：把题目里的条件看漏、引用了讲义里没有的结论、同一个问题换个问法答案就变。建议新人先收集 20 条失败的提问，按原因分类，再比较两种提示写法各错了几条。整个过程只需要会用 Python 调用模型接口，不需要训练模型。",
  },
  {
    title: "课程资料摘抄：公开数据集检查清单",
    text: "课程资料摘抄：拿到一个公开小数据集，先统计每一类有多少条，再随机抽查 50 条看有没有标错。常见问题是类别数量相差很大、重复样本、标注前后不一致。只需要 Python 和表格处理，一台普通笔记本就能完成，不需要 GPU。",
  },
  {
    title: "实验课讲义摘抄：两种分类算法的对比实验",
    text: "实验课讲义摘抄：在同一份数据上分别训练逻辑回归和决策树，固定随机种子与训练集划分，比较准确率并记录错分样本。换一组参数再跑一次，写下哪个更好以及可能的原因。需要 Python 与常用机器学习库，概率统计基础会有帮助。",
  },
] as const;
const CANDIDATES = [
  {
    material: 0,
    quote: "建议新人先收集 20 条失败的提问，按原因分类，再比较两种提示写法各错了几条",
    title: "给课程答疑机器人做 20 条失败用例并分类",
    question: "我是否喜欢“找问题、做比较、解释原因”这类工作？",
    activities: ["收集让机器人出错的提问", "把失败按原因分类", "换一种提示写法再试", "比较两种写法各错了几条"],
    deliverable: "一张失败分类表，加一段两种提示写法的对比说明",
    firstTask: { title: "收集 20 条让答疑机器人出错的提问", input: "课程讲义和往届答疑记录", output: "20 条失败提问的表格", estimateMinutes: 45 },
    initialTasks: [
      { title: "把 20 条失败按原因分成几类", input: "失败提问表格", output: "失败分类表", estimateMinutes: 60 },
      { title: "换一种提示写法再试并比较", input: "失败分类表", output: "两种写法的对比说明", estimateMinutes: 60 },
    ],
    range: { min: 150, max: 300 },
    requirements: [{ label: "会用 Python 调用模型接口", status: "unknown" as const, basis: "资料里写明需要；还没确认你是否做过", confirmedByOwner: false }],
    unknowns: ["有没有可用的模型接口额度"],
    fitReason: "和关注方向“让智能系统稳定完成任务”直接对应，不需要训练模型，两周内能做完。",
  },
  {
    material: 1,
    quote: "先统计每一类有多少条，再随机抽查 50 条看有没有标错",
    title: "检查一个公开小数据集的质量",
    question: "我是否耐得住细看数据、喜欢从数据里发现问题？",
    activities: ["统计每一类的数量", "抽查 50 条标注", "记录发现的问题", "整理成检查报告"],
    deliverable: "一份数据检查报告",
    firstTask: { title: "选一个公开小数据集并统计每一类的数量", input: "一个公开小数据集", output: "类别数量表", estimateMinutes: 40 },
    initialTasks: [{ title: "随机抽查 50 条并记录标注问题", input: "数据集", output: "问题清单", estimateMinutes: 90 }],
    range: { min: 120, max: 240 },
    requirements: [{ label: "Python 和表格数据处理", status: "unknown" as const, basis: "资料里写明需要；还没确认", confirmedByOwner: false }],
    unknowns: [],
    fitReason: "一台普通笔记本就能完成，可以和上一个候选对比“看数据”与“找失败”哪个更想继续。",
  },
  {
    material: 2,
    quote: "固定随机种子与训练集划分，比较准确率并记录错分样本",
    title: "在同一份数据上公平比较两种分类算法",
    question: "我是否喜欢设计实验、分析结果这类科研工作？",
    activities: ["各训练一次逻辑回归和决策树", "固定随机种子和数据划分", "换一组参数再跑", "写下差别和可能的原因"],
    deliverable: "一页实验对比记录",
    firstTask: { title: "装好环境，让逻辑回归在小数据上跑通", input: "Python 环境与一份小数据", output: "第一次运行的准确率", estimateMinutes: 60 },
    initialTasks: [{ title: "同样的划分下跑决策树并记录错分样本", input: "同一份数据", output: "两种算法的结果表", estimateMinutes: 90 }],
    range: { min: 180, max: 360 },
    requirements: [
      { label: "Python 与常用机器学习库", status: "unknown" as const, basis: "资料里写明需要；还没确认", confirmedByOwner: false },
      { label: "概率统计基础", status: "unknown" as const, basis: "资料说“会有帮助”；这学期正在上这门课", confirmedByOwner: false },
    ],
    unknowns: ["概率统计学到哪一章才够用"],
    fitReason: "对应“比较两种方法谁更好、为什么”，是科研里最常见的一类工作。",
  },
] as const;

type Applied = Extract<ReturnType<typeof executeCommand>, { ok: true }>;

/**
 * 种子里的每一步都必须成功：失败就抛出，让整次恢复回滚并把原因带出来。
 * 这里只执行操作本身，不逐步重排——二十多步各排一次要好几秒；全部写完后统一重排一次，结果相同。
 */
function mustRun(ctx: CommandContext, command: Record<string, unknown>): Applied {
  const result = executeCommand(command, ctx);
  if (!result.ok) throw new Error(`演示数据写入失败（${String(command.command)}）：${result.error}`);
  return result;
}

function refId(result: Applied, kind: string): string {
  const ref = result.refs.find((r) => r.kind === kind);
  if (!ref) throw new Error(`演示数据写入后没有找到 ${kind}`);
  return ref.id;
}

export function seedDemoData(now: Date): void {
  const cfg = getConfig();
  const db = getDb();
  const tz = instanceTimezone();
  const today = localDateInTz(now, tz);
  const monday = mondayOf(today);
  const day = (offset: number) => addDays(today, offset);
  /** 本周的周几（1=周一 … 7=周日） */
  const weekday = (n: number) => addDays(monday, n - 1);
  const ctx: CommandContext = { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "演示示例数据", now };
  const run = (command: Record<string, unknown>) => mustRun(ctx, command);

  // 调用预算：演示实例用环境变量给的全站上限（读取时还会再封顶一次）；定期任务照常，让访客看到自动更新
  db.prepare(`INSERT INTO settings (key, value_json, version, updated_at) VALUES (?, ?, 1, ?)`).run(
    AI_BUDGET_SETTINGS_KEY,
    JSON.stringify(aiBudgetSchema.parse({ dailyModelCalls: cfg.DEMO_DAILY_MODEL_CALLS, dailySearchCalls: cfg.DEMO_DAILY_SEARCH_CALLS })),
    now.toISOString(),
  );

  // ===== 身份、作息、课表 =====
  run({ command: "update_profile_fact", facts: [
    { field: "education_level", value: "本科" },
    { field: "program", value: "人工智能" },
    { field: "study_year", value: "大二" },
    { field: "campus", value: "东校区" },
  ] });
  run({
    command: "update_planning_policy",
    base: { workdayStart: "08:00", workdayEnd: "22:30", weekendStart: "09:30", weekendEnd: "22:00", dailyLimitMinutes: 180, minBlockMinutes: 30, bufferPercent: 20, meals: [["12:00", "13:00"], ["18:00", "19:00"]] },
    rules: [{ kind: "preferred_window", value: { part: "evening" } }],
    confirm: true,
    evidence: "演示示例：示例同学确认过的作息",
  });
  run({ command: "upsert_course_set", sdctText: SDCT, firstMonday: addDays(monday, -35), timezone: tz });
  run({ command: "import_fixed_events", timezone: tz, events: [
    { title: "机器人社例会", eventDate: weekday(3), localStart: "19:00", localEnd: "20:30" },
    { title: "和导师组旁听组会", eventDate: weekday(5), localStart: "16:00", localEnd: "17:30" },
    { title: "社团招新摆摊", eventDate: weekday(6), localStart: "14:00", localEnd: "16:30" },
    { title: "机器人社例会", eventDate: addDays(weekday(3), 7), localStart: "19:00", localEnd: "20:30" },
  ] });

  // ===== 目标与项目 =====
  const goalStudy = refId(run({ command: "upsert_goal", title: "这学期把数据结构和线性代数学扎实", reason: "后面的算法课和机器学习都要用，不想再靠考前突击。", horizon: "semester", primary: true }), "goal");
  const goalDirection = refId(run({ command: "upsert_goal", title: "大二结束前试出一个愿意长期投入的 AI 方向", reason: "先做几个两周的小项目，看自己更喜欢做工具、做实验还是看数据。", horizon: "long_term" }), "goal");
  const courseProject = createProject({
    title: "数据结构大作业：图书管理系统",
    question: "能不能自己选对数据结构，把增删查改和借阅记录做完整？",
    expectedOutcome: "一个命令行程序 + 一页设计说明，第 9 周课上演示。",
    prerequisites: "链表、哈希表、二叉搜索树",
    reviewQuestions: "哪一处的数据结构选得不合适？如果重做会怎么改？",
    goalIds: [goalStudy],
  });

  // ===== 任务：学习、待办、决策各有几件；截止日围绕本周，安排由重排算出来 =====
  const task = (input: Record<string, unknown>) => refId(run({ command: "create_or_update_task", ...input }), "task");
  const doneTask = task({ title: "数据结构：第 4 章串与数组习题", taskKind: "study", estimateMinutes: 90, dueLocalDate: day(-1) });
  const treeTask = task({ title: "数据结构：完成第 5 章二叉树习题", taskKind: "study", estimateMinutes: 120, dueLocalDate: day(2), priority: "high" });
  task({ title: "线性代数：复习第 3 章向量空间并做课后题", taskKind: "study", estimateMinutes: 150, dueLocalDate: day(4) });
  task({ title: "概率论：整理第 2 章随机变量的笔记", taskKind: "study", estimateMinutes: 90, dueLocalDate: day(6) });
  task({ title: "Python 实验三：文件处理与异常，写实验报告", taskKind: "study", estimateMinutes: 120, dueLocalDate: day(3), dueLocalTime: "23:00" });
  task({ title: "英语：准备课堂展示（5 分钟，介绍一个 AI 应用）", taskKind: "study", estimateMinutes: 60, dueLocalDate: day(5) });
  task({ title: "图书管理系统：定下数据结构和接口", taskKind: "study", estimateMinutes: 180, dueLocalDate: day(9), projectId: courseProject.id });
  task({ title: "物理实验报告：单摆测重力加速度", taskKind: "study", estimateMinutes: 60, dueLocalDate: day(-1), priority: "high" });
  task({ title: "去教务处给奖学金申请表盖章", taskKind: "todo", dueLocalDate: day(1) });
  task({ title: "决定要不要报名校内程序设计新生赛", taskKind: "decision", dueLocalDate: day(5) });

  // ===== 已经发生的投入：过去几天的实践记录，其中一件任务已完成 =====
  run({ command: "record_practice", occurredOn: day(-3), actualMinutes: 50, note: "看完第 4 章讲义，做了前 6 道题", taskId: doneTask });
  run({ command: "complete_task", taskId: doneTask, occurredOn: day(-2), actualMinutes: 45, note: "剩下的题做完，KMP 那道对着讲义才写出来" });
  run({ command: "record_practice", occurredOn: day(-2), actualMinutes: 40, note: "线性代数：重看了基与维数那一节", qualitative: "as_expected" });
  run({ command: "record_practice", occurredOn: day(-1), actualMinutes: 35, note: "二叉树遍历：递归版写完，非递归的中序还没跑通", taskId: treeTask, blocker: "非递归中序遍历的栈什么时候弹出没想清楚" });
  run({ command: "record_practice", occurredOn: day(-1), actualMinutes: 60, note: "篮球训练", category: "other" });
  const mustLog = (input: Parameters<typeof createLog>[0]) => {
    const r = createLog(input);
    if (r === "content_conflict") throw new Error("演示数据写入失败（记录重复）");
    return r.log;
  };
  const blockerLog = mustLog({ clientEntryId: "demo-log-1", occurredOn: day(-2), progress: "图书管理系统：列了需要的功能，借阅记录打算用链表", blocker: "按书名查找用哈希表还是二叉搜索树，拿不准", taskId: null, projectId: courseProject.id });
  mustLog({ clientEntryId: "demo-log-2", occurredOn: day(-1), progress: "二叉树的递归遍历都写对了，前序、后序的非递归版也跑通", blocker: "非递归中序总是多弹一次栈", taskId: treeTask, projectId: null });

  // ===== 方向：阶段、关注方向、一次探索（三个候选），其中一个开始两周试做 =====
  const entryYear = Number(addDays(monday, -35).slice(0, 4)) - 1;
  run({ command: "update_direction_profile", confirmedStage: "year2", entryYear, pathPreferences: ["research", "employment"] });
  const trackAgents = refId(run({ command: "upsert_direction_track", templateKey: "reliable_agents", status: "following", ownerNotes: "社团学长在做课程答疑机器人，想看看“找失败、做比较”这类工作自己喜不喜欢。" }), "direction_track");
  const trackData = refId(run({ command: "upsert_direction_track", templateKey: "data_quality", status: "exploring" }), "direction_track");
  const roadmap = refId(run({ command: "update_roadmap_item", stageKey: "year2", title: "用两个两周的小项目，比较“找失败”和“看数据”哪个更想继续", purpose: "不急着定方向，先各做一遍再比较感受。", goalId: goalDirection, trackId: trackAgents }), "roadmap_item");
  run({ command: "link_resource", title: "学长建议：大二先别急着进组", body: "学长说：大二先做两三个小项目，知道自己喜欢哪类工作再去找老师；进组以后时间不由自己安排，基础课别落下。", noteKind: "advice", trackId: trackAgents, stageKey: "year2", origin: "user" });

  // 探索记录是事先写好的（不是模型生成）：integration_mode 记为 fixture，页面上标“示例数据”
  const exploration = insertRun({ kind: "on_demand", topicId: null, topicVersion: null, projectId: null, query: EXPLORE_QUERY, integrationMode: "fixture", background: "大二，人工智能专业；会 Python，没训练过模型；每周能拿出三四个小时。" });
  setRunStage(exploration.id, "generating", { startedAt: now.toISOString() });
  const evidence = MATERIALS.map((m) => insertEvidence({ runId: exploration.id, hitId: null, url: null, canonicalUrl: null, title: m.title, text: m.text, status: "user_supplied", contentHash: contentHash(m.text), publishedAt: null, retrievedAt: now.toISOString() }));
  const candidates = CANDIDATES.map((c) => {
    if (!MATERIALS[c.material].text.includes(c.quote)) throw new Error(`演示数据写入失败：候选「${c.title}」的引用不在资料原文里`);
    return insertCandidate({
      runId: exploration.id,
      topicId: null,
      title: c.title,
      question: c.question,
      activities: [...c.activities],
      deliverable: c.deliverable,
      firstTask: { ...c.firstTask },
      initialTasks: c.initialTasks.map((t) => ({ ...t })),
      estimatedMinutesRange: { ...c.range },
      requirements: c.requirements.map((r) => ({ ...r })),
      unknowns: [...c.unknowns],
      fitReason: c.fitReason,
      sourceRefs: [{ evidenceId: evidence[c.material].id, quote: c.quote }],
      evidenceStatus: "user_supplied",
      canonicalUrl: null,
      evidenceHash: evidenceHash([c.quote]),
      supersedesId: null,
    });
  });
  finishRun(exploration.id, "done", { diagnostics: [{ at: now.toISOString(), stage: "publish", message: "演示示例：资料与候选是事先写好的，没有调用搜索或模型" }] });
  const trial = run({ command: "select_candidate", candidateId: candidates[0].id, mode: "trial", trialWeeks: 2, goalId: goalDirection, trackId: trackAgents, roadmapItemId: roadmap });
  const trialProject = refId(trial, "project");
  // 试做的第一步是要花时间做的事：明确记为学习任务，让它进入安排（否则会先问“要不要投入时间”）
  run({ command: "create_or_update_task", taskId: refId(trial, "task"), taskKind: "study", dueLocalDate: day(8) });
  run({ command: "record_practice", occurredOn: day(-1), actualMinutes: 30, note: "翻了往届答疑记录，先记下 8 条机器人答错的提问", projectId: trialProject });
  run({ command: "record_direction_reflection", text: "收集失败用例比想象中有意思，尤其是发现它总是漏掉同一类条件；但怎么分类有点拿不准标准。", occurredOn: day(-1), projectId: trialProject, trackId: trackAgents });
  run({ command: "configure_exploration", title: "大模型应用的可靠性与评测", purpose: "找适合大二学生、两周内能做完的小项目。", enabled: false, weekday: 6, localTime: "10:00" });
  void trackData;

  // ===== 通知：三条编出来的群通知，条件和行动是手填的结构（没有调用模型提取） =====
  createSource("counselor-group", "辅导员通知群");
  const notice = (externalId: string, text: string, structured: Record<string, unknown>) => {
    const r = importVerifiedNotice({ schemaVersion: 1, source: "counselor-group", externalId, revisionKey: "r1", revisionOrder: 1, occurredAt: now.toISOString(), text, structured: structured as never }, { automaticExtraction: false });
    if (!r.ok) throw new Error(`演示数据写入失败（通知 ${externalId}）：${r.error}`);
    return r.messageId;
  };
  const courseNotice = notice(
    "demo-notice-1",
    "【教务通知】本学期选课确认：请全体本科生于本周日 22:00 前登录教务系统，核对并确认本人课表；逾期系统关闭，不再受理补选。",
    { noticeType: "教务通知", condition: { kind: "leaf", field: "education_level", op: "eq", value: "本科", quote: "全体本科生" }, action: { actionKey: "confirm-courses", title: "在教务系统确认本学期课表", description: "登录教务系统核对课表并点确认。", due: { kind: "date", localDate: weekday(7), timezone: tz }, required: true } },
  );
  notice(
    "demo-notice-2",
    "【奖助通知】研究生学业奖学金本周开放申请，申请人须为在读研究生，请在系统内填写申请表并上传成绩单。",
    { noticeType: "奖助通知", condition: { kind: "leaf", field: "education_level", op: "eq", value: "研究生", quote: "申请人须为在读研究生" }, action: { actionKey: "apply-scholarship", title: "填写研究生学业奖学金申请表", description: "", required: true } },
  );
  notice(
    "demo-notice-3",
    "【社团通知】校内“智能体应用”作品赛开始报名，面向东校区学生，自愿参加，两到三人组队，报名截止下周三。",
    { noticeType: "竞赛通知", condition: { kind: "leaf", field: "campus", op: "eq", value: "东", quote: "面向东校区学生" }, action: { actionKey: "join-contest", title: "报名校内“智能体应用”作品赛", description: "两到三人组队。", due: { kind: "date", localDate: addDays(weekday(3), 7), timezone: tz }, required: false } },
  );
  const noticeTask = refId(run({ command: "apply_notice", messageId: courseNotice }), "task");
  run({ command: "create_or_update_task", taskId: noticeTask, taskKind: "todo" });

  // ===== 复盘：事实由程序从上面的记录汇总；观察与建议是事先写好的，同样标为示例 =====
  const reviewMonday = mondayOf(day(-2));
  const review = insertReview({ localMonday: reviewMonday, timezone: tz, trigger: "manual" });
  const facts = weekFacts(reviewMonday, tz);
  if (!hasRecords(facts) || !facts.logs.some((l) => l.id === blockerLog.id)) throw new Error("演示数据写入失败：复盘那一周没有汇总到示例记录");
  const logIds = facts.logs.map((l) => l.id);
  const proposals = translateProposals(
    [{ reason: "两条记录的卡点都出在“先想清楚再写”的地方：先在纸上把栈的变化画一遍，再回到代码。", evidenceIds: logIds.slice(0, 2), operations: [{ kind: "create_task", title: "在纸上画一遍非递归中序遍历的栈变化", description: "用一棵 5 个结点的树，逐步写出每次入栈、出栈和访问的结点。", estimateMinutes: 30, projectId: null, week: "this" }] }],
    {
      inputVersions: Object.fromEntries([...facts.logs.map((l) => [`log:${l.id}`, l.version]), ...facts.artifacts.map((a) => [`artifact:${a.id}`, a.version]), ...facts.openTasks.map((t) => [`task:${t.id}`, t.version])]),
      evidenceIds: new Set([...logIds, ...facts.completedTasks.map((t) => t.id), ...facts.openTasks.map((t) => t.id), ...facts.artifacts.map((a) => a.id)]),
      taskIds: new Set(facts.openTasks.map((t) => t.id)),
      projectIds: new Set(facts.projects.map((p) => p.id)),
      projectId: null,
      sourceKind: "review",
      sourceId: review.id,
      groupId: crypto.randomUUID(),
      groupTitle: `${reviewMonday} 周复盘`,
    },
  );
  finishReview(review.id, {
    status: "ready",
    facts,
    integrationMode: "fixture",
    aiDraft: {
      factNotes: [{ text: `这一周有 ${facts.counts.logs} 条进展记录，完成了 ${facts.counts.completed} 项任务。`, evidenceIds: logIds.slice(0, 1) }],
      observations: [{ text: "记录里的卡点可能都和“动手之前没有把过程想清楚”有关，不一定是知识点没学会。", evidenceIds: logIds.slice(0, 2) }],
      proposalIds: proposals.created.map((p) => p.id),
      dropped: proposals.dropped,
      insufficientReason: null,
    },
  });

  // ===== 学习安排：任务、课表、固定活动和作息都齐了，统一排一次未来七天的学习块 =====
  rebuildPlan(now);

  // ===== 对话：一条开场白，说明这里能做什么 =====
  appendTurn({
    conversationId: currentConversationId(now),
    role: "agent",
    text: "你好，这里是演示环境，数据是一位虚构的大二同学这一周的课表、任务和记录。可以直接对我说要做的事，比如“明天找个空档，安排一个半小时复习线性代数”“今晚有活动，把今晚的安排挪到这周其他时间”，或者把一条通知原文贴给我。改动都记在“最近变化”里，可以撤销。",
  });

  // ===== AI 资讯：资讯必须来自真实来源，不写假新闻。没有可用的盘点时排一次更新，由 worker 按订阅源生成 =====
  // 没配模型时这一步办不成（资讯页会如实显示“未配置”），不影响其余示例
  if (!latestNewsDigest()) executeCommand({ command: "request_ai_news", days: 7 }, ctx);
}
