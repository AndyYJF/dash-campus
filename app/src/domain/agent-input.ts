import { hasClockTime } from "./arrange";

/** Human commands are shared by buttons, the composer and server admission. */
export const AGENT_COMMANDS = [
  { name: "view", token: "/查看", label: "查看现状", hint: "例如：本周时间安排、明天课表、剩余学习时间" },
  { name: "process", token: "/处理", label: "处理事项", hint: "写下希望 Agent 怎么处理" },
  { name: "arrange", token: "/安排", label: "安排到某个时间", hint: "例如：下午3点到4点写作业；或先点一个空档再写要做的事" },
  { name: "adjust", token: "/调整", label: "调整安排", hint: "例如：把这段挪到明天下午" },
  { name: "study", token: "/学习", label: "纳入学习", hint: "确认当前事项或填写已有事项名" },
  { name: "todo", token: "/待办", label: "只记待办", hint: "保留事项与提醒，不自动排学习" },
  { name: "decision", token: "/决策", label: "先做决策", hint: "先决定是否投入，不自动排学习" },
  { name: "notice", token: "/通知", label: "保留通知", hint: "保留信息与截止提醒" },
  { name: "event", token: "/活动", label: "标为活动", hint: "分类本身不会编造起止时间" },
  { name: "record", token: "/记录", label: "记录进展", hint: "写已做了什么、多久、卡在哪里" },
  { name: "answer", token: "/回答", label: "回答问题", hint: "先选一个待回答问题" },
  { name: "policy", token: "/规则", label: "修改时间规则", hint: "例如：晚上十点后不排学习" },
  { name: "review", token: "/复盘", label: "发起复盘", hint: "上周或本周；不填默认为上周" },
  { name: "explore", token: "/探索", label: "寻找方向", hint: "写感兴趣的方向或项目条件" },
  { name: "import", token: "/导入", label: "导入材料", hint: "放入文字、链接、课表或文件" },
  { name: "undo", token: "/撤销", label: "撤销最近变化", hint: "走现有版本检查，不覆盖后续修改" },
] as const;
export type AgentCommandName = (typeof AGENT_COMMANDS)[number]["name"];
export type AgentText = { command: AgentCommandName | null; body: string; error: string | null };

export function parseAgentText(text: string): AgentText {
  const value = text.trim();
  if (!value.startsWith("/")) return { command: null, body: text, error: null };
  // Only a leading token is a command. Slashes inside pasted documents/URLs stay data.
  const match = /^(\/\S*)(?:\s+([\s\S]*))?$/.exec(value)!;
  const command = AGENT_COMMANDS.find((c) => c.token === match[1]);
  return command ? { command: command.name, body: match[2] ?? "", error: null } : { command: null, body: text, error: `不认识指令「${match[1]}」。点击“/ 指令”选择，或去掉前缀直接说。` };
}

export function formatAgentText(command: AgentCommandName, text = ""): string {
  return `${AGENT_COMMANDS.find((c) => c.name === command)!.token} ${text}`;
}

export function agentInputIssue(input: AgentText, ctx: { hasFiles: boolean; hasUrls: boolean; hasTask: boolean; hasQuestion: boolean; hasSlot: boolean }): string | null {
  if (input.error) return input.error;
  if (ctx.hasQuestion && input.command && input.command !== "answer") return "当前正在回答一个问题；要发起其他操作，请先取消这个问题上下文。";
  if (ctx.hasQuestion && ctx.hasFiles) return "问题回答暂时只支持文字；附件保留，可取消问题上下文后导入。";
  if (ctx.hasQuestion && input.body.length > 2000) return "问题回答最多 2000 字；长材料请取消问题上下文后导入。";
  if (input.command === "answer" && !ctx.hasQuestion) return "先从“待回答”选择要回答的问题。";
  if (["study", "todo", "decision", "notice", "event"].includes(input.command ?? "")) {
    if (ctx.hasFiles || ctx.hasUrls) return "这条指令用于纠正已有事项；导入新材料请用 /导入 或直接放入材料。";
    return input.body.trim() || ctx.hasTask ? null : "请先点一个事项，或在指令后写已有事项的名称。";
  }
  // /安排：要么点了空档，要么话里自己写了钟点
  if (input.command === "arrange" && !ctx.hasSlot && !hasClockTime(input.body)) return "请写上时间（比如“下午3点到4点写作业”），或先点时间线上的一个空档再说要安排什么。";
  if (input.command === "undo") return input.body.trim() ? "撤销最近变化只需 /撤销，不需要额外参数。" : null;
  if (input.command === "review") return /^(上周|本周|这周)?$/.test(input.body.trim()) ? null : "复盘范围请写“上周”或“本周”。";
  if (input.command === "view" && !input.body.trim() && !ctx.hasFiles && !ctx.hasUrls) return null;
  if (input.command === "import" || input.command === null) return input.body.trim() || ctx.hasFiles || ctx.hasUrls ? null : "内容不能为空。";
  if (!input.body.trim()) return "请在指令后写下具体内容。";
  if (["view", "arrange", "adjust", "policy", "record", "explore", "answer"].includes(input.command) && (ctx.hasFiles || ctx.hasUrls)) return "这条操作请用文字说明；新材料可通过 /导入 单独提交。";
  return null;
}
