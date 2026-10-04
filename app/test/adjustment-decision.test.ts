import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll, getDb } from "./helpers";
import { createOwner, createSession, SESSION_COOKIE } from "@/domain/session";
import { hashPassword } from "@/domain/password";
import { setNowForTests } from "@/domain/clock";
import { setProvidersForTests } from "@/integrations";
import { FakeModelProvider } from "@/integrations/fake-model-provider";
import { POST } from "@/app/api/v2/intakes/route";
import { POST as answerRoute } from "@/app/api/v2/questions/[id]/answers/route";
import { runDueJobsOnce } from "@/worker/runner";
import { intakeResultById } from "@/workflows/results";
import { executeOperation } from "@/workflows/commands";
import { dashboardSnapshot } from "@/workflows/snapshot";
import { isFlexibleAdjustment, adjustmentScope, validateAdjustment } from "@/workflows/adjustment-decision";
import type { ModelRequest } from "@/contracts/model";
const NOW = new Date("2026-10-04T08:00:00+08:00");
let token="",csrf="",seq=0,calls=0;
let reply: (r: ModelRequest) => unknown;
function request(body:unknown){return new NextRequest("http://localhost/api/v2/intakes",{method:"POST",headers:{cookie:`${SESSION_COOKIE}=${token}`,"x-csrf-token":csrf,"content-type":"application/json","idempotency-key":`flex-${seq++}`},body:JSON.stringify(body)});}
async function drain(){for(let i=0;i<4;i++)await runDueJobsOnce();}
async function say(text:string,extra:Record<string,unknown>={}){const res=await POST(request({text,...extra}));assert.equal(res.status,202,await res.clone().text());const {intakeId}=await res.json() as {intakeId:string};await drain();return intakeResultById(intakeId)!;}
async function answer(q:{id:string;version:number},text:string){const res=await answerRoute(request({text,expectedVersion:q.version}),{params:Promise.resolve({id:q.id})});assert.equal(res.status,202,await res.clone().text());await drain();}
function op(command:Record<string,unknown>){const r=executeOperation(command,{intakeId:null,itemId:null,itemKey:"",instanceEpoch:0,evidence:"",explicit:true,now:NOW});assert.ok(r.result.ok,JSON.stringify(r));return r;}
function replan(){return {kind:"act",rationale:"依据实际课程和预算，默认重排2026-10-04至2026-10-10的七天学习时间，保留手动和锁定安排。",intents:[{op:"replan",dateFrom:"2026-10-04",dateTo:"2026-10-10"}]};}
function facts(){return Object.fromEntries(["tasks","courses","plan_sessions","planning_preferences","planning_policy_rules","agent_action_batches"].map(t=>[t,getDb().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));}
before(async()=>{
 migrateAll();setNowForTests(NOW);createOwner(hashPassword("flex-test-pass"));const s=createSession(1);token=s.token;csrf=s.session.csrfToken;
 reply=()=>replan();setProvidersForTests({model:{mode:"fixture",provider:new FakeModelProvider(r=>{calls++;return {ok:true,validatedResult:reply(r)};})}});
 const course=await say("SDCT1\nT=18\nP=1,09:00-09:45;2,09:55-10:40\nC=微积分|李老师|B101|1|1-2|1-18|A|-");
 const anchor=course.questions.find(q=>q.purpose==="semester_anchor");assert.ok(anchor);await answer(anchor,"第5周");
 op({command:"create_or_update_task",title:"复习微积分",taskKind:"study",remainingMinutes:180,estimateMinutes:180});
 op({command:"schedule_session",title:"手动安排编程",date:"2026-10-05",startLocalTime:"18:00",durationMinutes:30});
});
after(()=>setNowForTests(null));
test("plain and slash ambiguous requests use real context and apply bounded replan without creating tasks",async()=>{
 const tasks=getDb().prepare("SELECT * FROM tasks ORDER BY id").all(),courses=getDb().prepare("SELECT * FROM courses ORDER BY id").all();
 const manual=getDb().prepare("SELECT * FROM plan_sessions WHERE origin='user' ORDER BY id").all();
 reply=r=>{assert.equal(r.workflow,"adjustment_decision");assert.equal(((r.context as Record<string,unknown>).days as unknown[]).length,7);assert.match(JSON.stringify(r.context),/微积分/);assert.match(JSON.stringify(r.context),/09:00/);assert.deepEqual((r.context as Record<string,unknown>).defaultScope,{dateFrom:"2026-10-04",dateTo:"2026-10-10"});return replan();};
 for(const text of ["根据每天的课程重新安排时间","/调整 根据每天的课程重新安排时间","学习安排优化一下，课多的日子轻松些"]){const r=await say(text);assert.ok(["applied","no_change"].includes(r.state),JSON.stringify(r));assert.match(r.summary,/七天/);assert.ok(r.followUps.some(f=>f.kind==="plan"));}
 assert.deepEqual(getDb().prepare("SELECT * FROM tasks ORDER BY id").all(),tasks);assert.deepEqual(getDb().prepare("SELECT * FROM courses ORDER BY id").all(),courses);assert.deepEqual(getDb().prepare("SELECT * FROM plan_sessions WHERE origin='user' ORDER BY id").all(),manual);
 for(let i=4;i<=10;i++){const d=dashboardSnapshot(`2026-10-${String(i).padStart(2,"0")}`,NOW).today;for(const s of d.sessions.filter(s=>["planned","tentative"].includes(s.status)))for(const e of d.events)assert.ok(s.endUtc<=e.startUtc||s.startUtc>=e.endUtc);}
});
test("a real tradeoff asks a concrete question, accepts natural answer and resumes the original request",async()=>{
 reply=r=>((r.context as Record<string,unknown>).replies as unknown[]).length?replan():{kind:"ask",question:"这周优先数学基础还是编程项目？",reason:"两个方向争用有限时间",options:["数学优先","编程优先"]};
 const before=facts();const r=await say("/调整 帮我优化学习计划");assert.equal(r.state,"needs_input");assert.deepEqual(facts(),before);
 const q=r.questions.find(q=>q.purpose==="agent_clarification");assert.ok(q);await answer(q,"先把数学基础补起来，项目后移");const done=intakeResultById(r.intakeId)!;assert.ok(["applied","no_change"].includes(done.state),JSON.stringify(done));assert.equal(done.questions.length,0);
});
test("inferred persistent rules require a concrete confirmation, rejection keeps everything unchanged",async()=>{
 reply=()=>({kind:"act",rationale:"建议长期每天最多学习120分钟",intents:[{op:"daily_limit",limitMinutes:120}]});
 const before=facts();const r=await say("/调整 最近安排太累了");assert.equal(r.state,"needs_input");const q=r.questions.find(q=>q.purpose==="confirm");assert.ok(q);assert.match(q.prompt,/120/);assert.deepEqual(facts(),before);await answer(q,"先不要");assert.equal(intakeResultById(r.intakeId)!.state,"answered");assert.deepEqual(facts(),before);
});
test("bad scope and unrelated or mixed actions never write domain data",async()=>{
 for(const intents of [[{op:"replan",dateFrom:"2026-10-04",dateTo:"2027-01-01"}],[{op:"course_cancel",date:"2026-10-05",courseName:null}],[{op:"move_session",ref:{kind:"recent"}},{op:"replan",dateFrom:"2026-10-04",dateTo:"2026-10-10"}]]){
  reply=()=>({kind:"act",rationale:"不合范围的建议",intents});const before=facts();const r=await say("/调整 按课程优化时间");assert.equal(r.state,"failed",JSON.stringify(r));assert.deepEqual(facts(),before);
 }
 assert.ok(validateAdjustment([{op:"replan",dateFrom:"2026-10-04",dateTo:"2026-99-99"}],"2026-10-04"));
});
test("read queries keep bypassing the decision model and slot context does not turn a replan into a task",async()=>{
 const before=facts(),n=calls;const r=await say("看一下目前每天的时间安排");assert.equal(r.state,"answered");assert.equal(calls,n);assert.deepEqual(facts(),before);
 reply=()=>replan();const taskRows=getDb().prepare("SELECT * FROM tasks ORDER BY id").all();const adjusted=await say("根据每天的课程重新安排时间",{slot:{date:"2026-10-05",start:"15:00",end:"16:00"}});assert.ok(["applied","no_change"].includes(adjusted.state));assert.deepEqual(getDb().prepare("SELECT * FROM tasks ORDER BY id").all(),taskRows);
 for(const t of ["明天参加报名通知","导入这个重新安排时间的通知","提醒我优化学习计划"])assert.equal(isFlexibleAdjustment(t),false);
});

test("explicit weekly scope follows calendar weeks, rejects silent expansion, and covers the last day of next week",async()=>{
 assert.deepEqual(adjustmentScope("这周按课表调整安排","2026-10-04"),{dateFrom:"2026-10-04",dateTo:"2026-10-04",explicit:true});
 assert.deepEqual(adjustmentScope("下周按课表调整安排","2026-10-04"),{dateFrom:"2026-10-05",dateTo:"2026-10-11",explicit:true});
 reply=()=>replan();const before=facts();const rejected=await say("/调整 本周重新安排时间");assert.equal(rejected.state,"failed");assert.match(rejected.summary,/超出/);assert.deepEqual(facts(),before);
 reply=()=>({kind:"act",rationale:"下周10月5日至11日按实际课程重新排程",intents:[{op:"replan",dateFrom:"2026-10-05",dateTo:"2026-10-11"}]});
 const r=await say("/调整 下周重新安排时间");assert.ok(["applied","no_change"].includes(r.state),JSON.stringify(r));assert.ok(r.followUps.some(f=>f.kind==="plan"));
});
