import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { executeOperation } from "@/workflows/commands";
import { createProject } from "@/repositories/planning";
import { createOwner } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { appendTurn, currentConversationId } from "@/repositories/conversations";
import { getDb } from "@/repositories/db";

/**
 * 语料评测的固定种子（Agent 方案 §6 P3）。全部是合成数据：课表、任务、学习块、目标、项目、实践与对话引用。
 * 只经注册操作或仓储写入，固定时钟；同名种子在任何库上生成相同的业务事实（ID 随库不同）。
 * 改动本文件会改变 fixtureFingerprint，旧录制随之失效。
 */

export const FIXTURE_NOW = "2026-10-12T18:00:00+08:00";
const TZ = "Asia/Shanghai";

/** 第 6 教学周 = 2026-10-12（周一） */
const TIMETABLE = [
  "SDCT1",
  "T=16",
  "P=1,08:00-09:35;2,10:00-11:35;3,14:00-15:35;4,16:00-17:35",
  "C=英语|王老师|C305|1|2|1-16|A|-",
  "C=高等数学|张老师|A101|2|1|1-16|A|-",
  "C=数据结构|李老师|B203|3|1|1-16|A|-",
  "C=体育|-|操场|3|3|1-16|A|-",
  "C=线性代数|赵老师|A102|4|2|1-16|A|-",
  "C=高数|张老师|A101|5|1|1-16|A|-",
].join("\n");

type Refs = Record<string, { kind: string; id: string }>;

function op(command: Record<string, unknown>): void {
  const r = executeOperation(command, { intakeId: null, itemId: null, itemKey: "", instanceEpoch: 0, evidence: "fixture", explicit: true, now: new Date(FIXTURE_NOW) });
  if (!r.result.ok) throw new Error(`fixture ${String(command.command)} 失败：${JSON.stringify(r.result)}`);
}

const taskId = (title: string) => (getDb().prepare(`SELECT id FROM tasks WHERE title = ? AND archived_at IS NULL`).get(title) as { id: string }).id;
const sessionOf = (title: string, date: string) =>
  (getDb().prepare(`SELECT s.id FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title = ? AND date(s.start_utc, '+8 hours') = ? ORDER BY s.start_utc LIMIT 1`).get(title, date) as { id: string } | undefined)?.id;

function weekBasic(): Refs {
  op({ command: "upsert_course_set", sdctText: TIMETABLE, firstMonday: "2026-09-07", timezone: TZ });
  op({ command: "import_fixed_events", events: [{ title: "社团活动", eventDate: "2026-10-15", localStart: "19:00", localEnd: "21:00" }, { title: "社团活动", eventDate: "2026-10-22", localStart: "19:00", localEnd: "21:00" }], timezone: TZ });
  op({ command: "upsert_goal", title: "打好数学基础", reason: "后续课程与科研都依赖数学", horizon: "semester", primary: true });
  const goal = getDb().prepare(`SELECT id FROM goals ORDER BY created_at DESC LIMIT 1`).get() as { id: string };
  const project = createProject({ title: "分类基线（科研项目）", question: "复现一个图像分类基线，试试是否喜欢科研", expectedOutcome: "跑通基线并写一页总结", prerequisites: "", reviewQuestions: "", goalIds: [] });
  // 先建无估时的任务并放好几段指定时刻的块（供“今晚/明天上午/周三晚上”引用），再补估时与截止，其余由排程算法围绕它们生成
  op({ command: "update_planning_policy", base: { dailyLimitMinutes: 240, workdayEnd: "23:00", weekendEnd: "23:00" }, confirm: true });
  op({ command: "schedule_session", title: "微积分复习", date: "2026-10-12", startLocalTime: "19:00", durationMinutes: 60 });
  op({ command: "schedule_session", title: "线代作业", date: "2026-10-12", startLocalTime: "20:10", durationMinutes: 50 });
  op({ command: "schedule_session", title: "英语作文", date: "2026-10-12", startLocalTime: "21:10", durationMinutes: 40 });
  op({ command: "schedule_session", title: "数据结构作业", date: "2026-10-13", startLocalTime: "10:00", durationMinutes: 60 });
  op({ command: "schedule_session", title: "操作系统实验报告", date: "2026-10-14", startLocalTime: "19:00", durationMinutes: 90 });
  for (const title of ["微积分习题集", "读论文"]) op({ command: "create_or_update_task", title, taskKind: "study" });
  op({ command: "create_or_update_task", taskId: taskId("操作系统实验报告"), estimateMinutes: 120, dueLocalDate: "2026-10-14", dueLocalTime: "23:59" });
  op({ command: "create_or_update_task", taskId: taskId("线代作业"), estimateMinutes: 90, dueLocalDate: "2026-10-15" });
  op({ command: "create_or_update_task", taskId: taskId("数据结构作业"), estimateMinutes: 60, dueLocalDate: "2026-10-13" });
  op({ command: "create_or_update_task", taskId: taskId("英语作文"), estimateMinutes: 60 });
  op({ command: "create_or_update_task", taskId: taskId("微积分习题集"), estimateMinutes: 240 });
  op({ command: "create_or_update_task", title: "整理基线代码", taskKind: "study", estimateMinutes: 120, projectId: project.id });
  op({ command: "record_practice", occurredOn: "2026-10-12", actualMinutes: 60, note: "线代复习", taskId: taskId("线代作业") });
  const practice = (getDb().prepare(`SELECT id FROM practice_entries ORDER BY created_at DESC LIMIT 1`).get() as { id: string }).id;

  // 对话：最近一轮 Agent 结果引用今晚的微积分复习（“刚才那个/刚排的那个”），更早一轮引用刚记的实践
  const conversationId = currentConversationId(new Date(FIXTURE_NOW));
  const calculus = sessionOf("微积分复习", "2026-10-12")!;
  appendTurn({ conversationId, role: "owner", text: "线代复习了一小时" });
  appendTurn({ conversationId, role: "agent", text: "已记录：今天线代复习 60 分钟。", refs: [{ kind: "practice_entry", id: practice }] });
  appendTurn({ conversationId, role: "owner", text: "今晚七点排一小时微积分复习" });
  appendTurn({ conversationId, role: "agent", text: "已把「微积分复习」排在今晚 19:00–20:00。", refs: [{ kind: "plan_session", id: calculus }, { kind: "task", id: taskId("微积分复习") }] });
  return {
    conversation: { kind: "conversation", id: conversationId },
    goal: { kind: "goal", id: goal.id },
    project: { kind: "project", id: project.id },
  };
}

const FIXTURES: Record<string, () => Refs> = { "week-basic": weekBasic };

/** 在已迁移的空库上建 owner 与种子；返回种子里的关键引用 */
export function seedFixture(name: string): Refs {
  const seed = FIXTURES[name];
  if (!seed) throw new Error(`没有叫 ${name} 的种子`);
  setNowForTests(new Date(FIXTURE_NOW));
  createOwner(hashPassword("eval-fixture-pass"));
  return seed();
}

/** 种子定义的指纹：本文件内容的 sha256 前缀 */
export function fixtureFingerprint(): string {
  const file = path.resolve(process.cwd(), "test/corpus/fixtures.ts");
  return crypto.createHash("sha256").update(fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
}

/** 语料里的“选中对象”名称 → 本库里的引用（找不到返回 null，评测记为种子缺口） */
export function resolveSelected(sel: { entityKind: string; name: string }): { ref?: { kind: string; id: string }; slot?: { date: string; start: string; end: string } } | null {
  const db = getDb();
  if (sel.entityKind === "slot") {
    const m = sel.name.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})-(\d{2}:\d{2})$/);
    return m ? { slot: { date: m[1]!, start: m[2]!, end: m[3]! } } : null;
  }
  if (sel.entityKind === "task") {
    const r = db.prepare(`SELECT id FROM tasks WHERE title LIKE ? AND archived_at IS NULL ORDER BY length(title) LIMIT 1`).get(`%${sel.name}%`) as { id: string } | undefined;
    return r ? { ref: { kind: "task", id: r.id } } : null;
  }
  if (sel.entityKind === "plan_session") {
    const r = db.prepare(`SELECT s.id FROM plan_sessions s JOIN tasks t ON t.id = s.task_id WHERE t.title LIKE ? AND s.status = 'planned' ORDER BY s.start_utc LIMIT 1`).get(`%${sel.name}%`) as { id: string } | undefined;
    return r ? { ref: { kind: "plan_session", id: r.id } } : null;
  }
  if (sel.entityKind === "course") {
    const r = db.prepare(`SELECT id FROM courses WHERE name = ? LIMIT 1`).get(sel.name) as { id: string } | undefined;
    return r ? { ref: { kind: "course", id: r.id } } : null;
  }
  return null;
}
