import assert from "node:assert/strict";
import crypto from "node:crypto";
import { before, beforeEach, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { setNowForTests } from "@/domain/clock";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { parseAgentText, agentInputIssue, formatAgentText } from "@/domain/agent-input";
import { POST } from "@/app/api/v2/intakes/route";
import { runDueJobsOnce } from "@/worker/runner";
import { getIntake, listItems } from "@/repositories/intakes";
import { listOpenQuestions } from "@/repositories/questions";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { rebuildPlan } from "@/workflows/plan";
import { raisePlanQuestions } from "@/workflows/agent";
import { executeOperation } from "@/workflows/commands";

const NOW = new Date("2026-10-04T08:00:00+08:00");
let token = "", csrf = "", seq = 0, modelCalls = 0;
function req(body: unknown, key = `slash-${seq++}`) {
  return new NextRequest("http://localhost/api/v2/intakes", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${token}`, "x-csrf-token": csrf, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) });
}
const count = (table: string) => (getDb().prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
function task(title: string, kind = "todo") {
  const id = crypto.randomUUID();
  getDb().prepare("INSERT INTO tasks (id,title,description,status,priority,estimate_minutes,due_kind,task_kind,created_at,updated_at) VALUES (?,?,'','todo','normal',60,'none',?,?,?)").run(id,title,kind,NOW.toISOString(),NOW.toISOString());
  return id;
}
async function say(text: string, context: Record<string, unknown> = {}) {
  const response = await POST(req({ text, ...context }));
  assert.equal(response.status, 202, await response.clone().text());
  const { intakeId } = await response.json() as { intakeId: string };
  for (let i = 0; i < 4; i++) await runDueJobsOnce();
  return { intake: getIntake(intakeId)!, items: listItems(intakeId) };
}
before(() => {
  migrateAll(); setNowForTests(NOW); createOwner(hashPassword("slash-test-pass"));
  const s = createSession(1); token=s.token; csrf=s.session.csrfToken;
  setProvidersForTests({ model: { mode: "fixture", provider: new FakeModelProvider((r) => { modelCalls++; const text=(r.context as {text:string}).text.trim(); return {ok:true, validatedResult:{items:[{itemKey:"material",kind:"note",summary:text.slice(0,100),excerpt:text.slice(0,100)}]}}; }) } });
});
beforeEach(() => getDb().exec("UPDATE tasks SET status='cancelled'; UPDATE plan_sessions SET status='superseded'; UPDATE clarification_questions SET status='superseded' WHERE status='open';"));
after(() => setNowForTests(null));

test("leading directives are shared; natural language and embedded URLs remain unchanged", () => {
  assert.deepEqual(parseAgentText("自然语言 https://example.com/a/b"), {command:null,body:"自然语言 https://example.com/a/b",error:null});
  assert.equal(parseAgentText("/记录 今天学了40分钟").body, "今天学了40分钟");
  assert.equal(parseAgentText(formatAgentText("study")).command, "study");
  assert.match(parseAgentText("/").error!, /不认识/);
  const ctx = {hasFiles:false,hasUrls:false,hasTask:false,hasQuestion:false,hasSlot:false};
  assert.match(agentInputIssue(parseAgentText("/回答 是"),ctx)!, /选择/);
  assert.match(agentInputIssue(parseAgentText("/复盘 每年"),ctx)!, /上周/);
});

test("invalid directives fail before intake admission and never create new tasks", async () => {
  const n=count("intakes"), t=count("tasks");
  for (const body of [{text:"/不存在 买东西"},{text:"/学习"},{text:"/安排 学数学"},{text:"/回答 好"}]) assert.equal((await POST(req(body))).status,422);
  assert.equal(count("intakes"),n); assert.equal(count("tasks"),t);
});

test("card /学习 targets the supplied task ID; /待办 withdraws its auto blocks without duplicating it", async () => {
  const id=task("同名事项"), other=task("同名事项"); const n=count("tasks"), calls=modelCalls;
  const first=await say("/学习",{selectedEntityRef:{kind:"task",id}});
  assert.equal(first.intake.context.agentCommand,"study"); assert.equal(first.intake.text,"/学习");
  assert.equal(first.items[0].state,"applied");
  assert.equal((getDb().prepare("SELECT task_kind FROM tasks WHERE id=?").get(id) as {task_kind:string}).task_kind,"study");
  assert.equal((getDb().prepare("SELECT task_kind FROM tasks WHERE id=?").get(other) as {task_kind:string}).task_kind,"todo");
  assert.ok(getDb().prepare("SELECT id FROM plan_sessions WHERE task_id=? AND status='planned'").all(id).length);
  await say("/待办",{selectedEntityRef:{kind:"task",id}});
  assert.equal(getDb().prepare("SELECT id FROM plan_sessions WHERE task_id=? AND status='planned'").all(id).length,0);
  assert.equal(count("tasks"),n); assert.equal(modelCalls,calls);
});

test("/安排 uses the selected local slot and creates exactly one manual block", async () => {
  const out=await say("/安排 读一篇综述",{slot:{date:"2026-10-05",start:"15:00",end:"16:00"}});
  assert.equal(out.items[0].state,"applied",JSON.stringify(out.items));
  const blocks=getDb().prepare("SELECT origin,start_utc,end_utc FROM plan_sessions s JOIN tasks t ON t.id=s.task_id WHERE t.title='读一篇综述' AND s.status='planned'").all() as {origin:string;start_utc:string;end_utc:string}[];
  assert.deepEqual(blocks,[{origin:"user",start_utc:"2026-10-05T07:00:00.000Z",end_utc:"2026-10-05T08:00:00.000Z"}]);
});

test("/调整 cannot fall back to creating tasks when its requested change is unclear", async () => {
  const n=count("tasks"); const out=await say("/调整 随便帮我安排得好一点");
  assert.equal(out.items[0].state,"failed"); assert.match(String(out.items[0].evidence?.error),/没有修改/); assert.equal(count("tasks"),n);
});

test("/调整 with selected session moves the same object and preserves duration", async () => {
  const result=executeOperation({command:"schedule_session",title:"练习线代",date:"2026-10-05",startLocalTime:"09:00",durationMinutes:40},{intakeId:null,itemId:null,itemKey:"",instanceEpoch:0,evidence:"",explicit:true,now:NOW});
  assert.ok(result.result.ok);
  const original=getDb().prepare("SELECT s.* FROM plan_sessions s JOIN tasks t ON t.id=s.task_id WHERE t.title='练习线代' AND s.status='planned'").get() as {id:string};
  const out=await say("/调整 明天下午",{selectedEntityRef:{kind:"plan_session",id:original.id}});
  assert.equal(out.items[0].state,"applied",JSON.stringify(out.items));
  const moved=getDb().prepare("SELECT start_utc,end_utc FROM plan_sessions WHERE id=?").get(original.id) as {start_utc:string;end_utc:string};
  assert.equal(new Date(moved.end_utc).getTime()-new Date(moved.start_utc).getTime(),40*60000);
  assert.equal(moved.start_utc.slice(0,10),"2026-10-05"); assert.notEqual(moved.start_utc,"2026-10-05T01:00:00.000Z");
});

test("/回答 carries question purpose and version; stale or closed answers never become intakes", async () => {
  const id=task("处理陌生材料","unknown"); raisePlanQuestions(rebuildPlan(NOW),{conversationId:null,tz:"Asia/Shanghai"});
  const q=listOpenQuestions().find(q=>q.context.taskId===id)!; assert.ok(q);
  const n=count("intakes");
  assert.equal((await POST(req({text:"/回答 只记待办",questionId:q.id,questionVersion:q.version+1}))).status,409);
  const good=await POST(req({text:"/回答 只记待办",questionId:q.id,questionVersion:q.version})); assert.equal(good.status,202,await good.clone().text());
  assert.equal((await good.json()).answered,true);
  assert.equal((await POST(req({text:"/回答 是",questionId:q.id,questionVersion:q.version}))).status,409);
  assert.equal(count("intakes"),n);
});

test("/记录 records only user-reported minutes and links the selected project", async () => {
  const id=crypto.randomUUID(); getDb().prepare("INSERT INTO projects (id,title,status,created_at,updated_at) VALUES (?,'学习项目','active',?,?)").run(id,NOW.toISOString(),NOW.toISOString());
  const out=await say("/记录 今天查了资料40分钟，卡在环境配置",{selectedEntityRef:{kind:"project",id}});
  assert.equal(out.items[0].state,"applied",JSON.stringify(out.items));
  const record=getDb().prepare("SELECT actual_minutes,minutes_origin,project_id FROM practice_entries WHERE project_id=?").get(id);
  assert.deepEqual(record,{actual_minutes:40,minutes_origin:"user_reported",project_id:id});
  const n=count("practice_entries"); const future=await say("/记录 明天准备学习两小时");
  assert.equal(future.items[0].state,"failed"); assert.equal(count("practice_entries"),n);
});

test("/导入 recognizes raw SDCT1 and asks its anchor; imperative material is not an owner policy change", async () => {
  const out=await say("/导入 SDCT1\nT=18\nP=1,08:15-09:00;2,09:10-09:55\nC=数学|老师|A101|1|1-2|1-16|A|-");
  assert.equal(out.items[0].kind,"timetable"); assert.equal(out.items[0].state,"awaiting_input");
  const imported=await say("/导入 晚上十点后不排学习");
  assert.ok(imported.items.every(i=>i.kind!=="command"));
});
