import { z } from "zod";
import { commandSchema, OPERATIONS, type Command, type OperationAuthorization } from "@/contracts/commands";
import { intentSchema, type Intent } from "./intent";

/**
 * 意图目录（Agent 增强 v1.1 P1）：每个意图会落到哪些注册操作，一个意图可以对应多个操作。
 * 给模型的工具说明从这里生成；不开放（never）或没有映射的操作不进入目录；覆盖测试保证两边一致。
 */

type Op = Intent["op"];
type CommandName = Command["command"];

export const INTENT_COMMANDS: { [K in Op]: readonly CommandName[] } = {
  inspect: [],
  explain: [],
  undo: ["undo_batch"],
  move_session: ["reschedule_session"],
  shorten_session: ["reschedule_session"],
  no_study: ["update_planning_policy"],
  weekday_limit: ["update_planning_policy"],
  group_limit: ["update_planning_policy"],
  daily_limit: ["update_planning_policy"],
  date_limit: ["update_planning_policy"],
  window_end: ["update_planning_policy"],
  window_start: ["update_planning_policy"],
  holiday_policy: ["update_planning_policy"],
  prefer_window: ["update_planning_policy"],
  replan: ["update_planning_policy"],
  revoke_replan: ["update_planning_policy"],
  confirm_policy: ["update_planning_policy"],
  pause_task: ["pause_task"],
  resume_task: ["pause_task"],
  classify_task: ["create_or_update_task"],
  prioritize: ["create_or_update_task", "upsert_goal"],
  set_due: ["create_or_update_task"],
  remaining: ["create_or_update_task"],
  complete: ["complete_task"],
  correct_practice: ["correct_practice"],
  goal: ["upsert_goal"],
  trial: ["select_candidate"],
  project_state: ["update_project_state"],
  explore: ["request_exploration"],
  resource_link: ["link_resource"],
  resource_role: ["link_resource"],
  profile: ["update_profile_fact"],
  notice_filter: ["upsert_notice_rule"],
  export: ["request_export"],
  schedule_here: ["schedule_session"],
  agent_policy: ["update_agent_policy"],
  review: ["request_review"],
  explore_topic: ["configure_exploration"],
  digest_now: ["request_owner_digest"],
  cancel_intake: ["cancel_operation"],
  fixed_event: ["update_fixed_event"],
  digest: ["update_digest_policy"],
  reminders: ["update_reminder_policy"],
  task_reminder: ["update_reminder_policy"],
  calendar_sync: ["update_calendar_sync_policy"],
  course_cancel: ["apply_teaching_day_override"],
  course_move: ["apply_teaching_day_override"],
  create_task: ["create_or_update_task"],
  practice: ["record_practice"],
  schedule_at: ["schedule_session"],
  session_state: ["set_session_state"],
  resolve_notice: ["resolve_notice"],
  archive: ["archive_entity"],
};

/** 只读意图：回答问题，不改任何数据 */
export const READ_ONLY_INTENTS: ReadonlySet<Op> = new Set<Op>(["inspect", "explain"]);

export const INTENT_DESCRIPTIONS: { [K in Op]: string } = {
  inspect: "查看/询问当前数据（今天安排、任务、截止、记录等），只读回答。",
  explain: "解释为什么这样安排或为什么没提醒，只读。",
  undo: "撤销这次对话里最近一次调整。",
  move_session: "把一个已有学习块挪到别的日期/时段/钟点。",
  shorten_session: "只改一个学习块的时长，位置不动。",
  no_study: "某段日期（可从某个钟点起）不安排学习，临时规则。",
  weekday_limit: "某个星期几的学习上限；persistent=false 时会先问只这一次还是以后都这样。",
  group_limit: "工作日或周末的长期学习上限（需确认）。",
  daily_limit: "每天学习上限，长期规则。",
  date_limit: "某一天的学习上限，临时规则。",
  window_end: "晚上几点后不排学习，长期作息。",
  window_start: "早上几点前不排学习，长期作息。",
  holiday_policy: "假期按周末模板、减量或不排。",
  prefer_window: "更喜欢在早上/下午/晚上/周末集中学习。",
  replan: "授权重新安排某段日期里未锁定、未开始的学习块（临时授权）。",
  revoke_replan: "撤回“可以重新安排”的授权。",
  confirm_policy: "确认待定的作息偏好。",
  pause_task: "暂停一个任务到某天或先不定。",
  resume_task: "恢复一个暂停的任务。",
  classify_task: "改一个任务的类型（学习/待办/决策/活动/通知/待确认）。",
  prioritize: "把任务设为高优先；对不上任务时设为主要目标。",
  set_due: "修改任务截止日期/时刻。",
  remaining: "报告任务还剩多少工作量（分钟）。",
  complete: "把一个已有任务标记完成，可带实际分钟。",
  correct_practice: "纠正最近一条实践记录的分钟。",
  goal: "新建或修改目标，primary=true 设为主要方向。",
  trial: "从候选里选一个开始试做或正式投入。",
  project_state: "暂停/恢复/结束项目，或转为正式投入。",
  explore: "按问题检索并生成候选项目。",
  resource_link: "把刚放进来的资料关联到某个项目。",
  resource_role: "说明刚放进来的资料是参考/要求/成果。",
  profile: "记录主人陈述的学历层次、专业、校区、年级等身份信息。",
  notice_filter: "某类人群专属的通知不进行动；remove 撤回。",
  export: "生成业务数据导出。",
  schedule_here: "在时间轴空档里安排一件事（从空档发起时使用）。",
  agent_policy: "每日模型调用上限、定期探索与复盘开关。",
  review: "生成上周或本周的复盘。",
  explore_topic: "新建/调整/停止一个定期关注方向。",
  digest_now: "立即给主人发今日或本周摘要邮件。",
  cancel_intake: "停止一份还没处理完的投递。",
  fixed_event: "修改、移除或跳过某天的非课程固定活动。",
  digest: "每日/每周摘要邮件的开关与时间。",
  reminders: "截止提醒开关与安静时段。",
  task_reminder: "某个任务提前多久提醒。",
  calendar_sync: "校历/节假日自动核对的开关与间隔。",
  course_cancel: "某门课或全校某天停课（单次）。",
  course_move: "某门课或某天的课调到另一天/另一个钟点（单次）。",
  create_task: "新建一个任务，可带类型、估时、截止、优先级，并可归入已有项目。",
  practice: "记录一次已经发生的学习/实践（日期可以是过去），可关联任务或项目，可记卡点。",
  schedule_at: "在指定日期和钟点给已有任务（taskRef）或新任务（title）安排一段学习。",
  session_state: "开始、完成、跳过、锁定或解锁一个学习块。",
  resolve_notice: "纠正一条通知的归类（要做/仅了解/机会/待判断/折叠）。",
  archive: "归档任务、目标或课表；其他对象不能归档，会说明该用什么操作。",
};

export type CatalogEntry = {
  op: Op;
  description: string;
  readOnly: boolean;
  commands: CommandName[];
  /** 对应操作里最严格的授权级别 */
  authorization: OperationAuthorization;
  jsonSchema: unknown;
};

const RANK: Record<OperationAuthorization, number> = { auto: 0, explicit: 1, confirm: 2, never: 3 };

function intentOptions() {
  return intentSchema.options as unknown as Array<z.ZodObject<{ op: z.ZodLiteral<Op> }>>;
}

export function intentOps(): Op[] {
  return intentOptions().map((o) => o.shape.op.value);
}

/** 给模型和测试看的意图目录：never 和没有映射到注册操作的意图不进入 */
export function intentCatalog(): CatalogEntry[] {
  const out: CatalogEntry[] = [];
  for (const option of intentOptions()) {
    const op = option.shape.op.value;
    const readOnly = READ_ONLY_INTENTS.has(op);
    const commands = INTENT_COMMANDS[op].filter((c) => OPERATIONS[c] && OPERATIONS[c].authorization !== "never");
    if (!readOnly && !commands.length) continue;
    const authorization = commands.reduce<OperationAuthorization>((acc, c) => (RANK[OPERATIONS[c].authorization] > RANK[acc] ? OPERATIONS[c].authorization : acc), "auto");
    out.push({ op, description: INTENT_DESCRIPTIONS[op], readOnly, commands, authorization, jsonSchema: z.toJSONSchema(option, { io: "input", unrepresentable: "any" }) });
  }
  return out;
}

/** 目录与注册表的一致性问题；空数组表示全部对齐 */
export function catalogProblems(): string[] {
  const problems: string[] = [];
  const registered = new Set((commandSchema.options as unknown as Array<z.ZodObject<{ command: z.ZodLiteral<CommandName> }>>).map((o) => o.shape.command.value));
  for (const op of intentOps()) {
    const commands = INTENT_COMMANDS[op];
    if (!commands) problems.push(`意图 ${op} 没有映射`);
    else if (READ_ONLY_INTENTS.has(op) && commands.length) problems.push(`只读意图 ${op} 不应映射到写操作`);
    else if (!READ_ONLY_INTENTS.has(op) && !commands.length) problems.push(`意图 ${op} 没有对应的注册操作`);
    for (const c of commands ?? []) {
      if (!registered.has(c)) problems.push(`意图 ${op} 映射到未注册 schema 的操作 ${c}`);
      if (!OPERATIONS[c]) problems.push(`意图 ${op} 映射到没有元数据的操作 ${c}`);
    }
    if (!INTENT_DESCRIPTIONS[op]) problems.push(`意图 ${op} 缺少说明`);
  }
  for (const name of Object.keys(OPERATIONS)) if (!registered.has(name as CommandName)) problems.push(`元数据里的操作 ${name} 没有 schema`);
  return problems;
}
