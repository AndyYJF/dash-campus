import assert from "node:assert/strict";
import crypto from "node:crypto";
import {before,after,test} from "node:test";
import {NextRequest} from "next/server";
import {migrateAll,getDb} from "./helpers";
import {createOwner,createSession,SESSION_COOKIE} from "@/domain/session";
import {hashPassword} from "@/domain/password";
import {setNowForTests} from "@/domain/clock";
import {isReadRequest} from "@/domain/read-request";
import {POST} from "@/app/api/v2/intakes/route";
import {runDueJobsOnce} from "@/worker/runner";
import {intakeResultById} from "@/workflows/results";
import {setProvidersForTests} from "@/integrations";
import {FakeModelProvider} from "@/integrations/fake-model-provider";
import {dashboardSnapshot} from "@/workflows/snapshot";
import {executeOperation} from "@/workflows/commands";
const NOW=new Date("2026-10-04T08:00:00+08:00");
let token="",csrf="",seq=0,modelCalls=0;
const tables=["tasks","plan_sessions","fixed_events","courses","projects","goals","practice_entries","agent_action_batches","agent_action_changes","availability_blocks","planning_preferences"];
function facts(){return Object.fromEntries(tables.map(t=>[t,getDb().prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));}
async function say(text:string,extra:Record<string,unknown>={}){
 const res=await POST(new NextRequest("http://localhost/api/v2/intakes",{method:"POST",headers:{cookie:`${SESSION_COOKIE}=${token}`,"x-csrf-token":csrf,"content-type":"application/json","idempotency-key":`view-${seq++}`},body:JSON.stringify({text,...extra})}));
 assert.equal(res.status,202,await res.clone().text());const body=await res.json() as {intakeId:string};
 for(let i=0;i<4;i++)await runDueJobsOnce();return intakeResultById(body.intakeId)!;
}
before(()=>{
 migrateAll();setNowForTests(NOW);createOwner(hashPassword("view-test-pass"));const s=createSession(1);token=s.token;csrf=s.session.csrfToken;
 setProvidersForTests({model:{mode:"fixture",provider:new FakeModelProvider(r=>{modelCalls++;const text=(r.context as {text:string}).text;return {ok:true,validatedResult:{items:[{itemKey:"wrong-task",kind:"task",summary:"查看被误分类",excerpt:text.trim().slice(0,100)}]}};})}});
 const r=executeOperation({command:"schedule_session",title:"实验基线",date:"2026-10-05",startLocalTime:"15:00",durationMinutes:40},{intakeId:null,itemId:null,itemKey:"",instanceEpoch:0,evidence:"",explicit:true,now:NOW});assert.ok(r.result.ok);
 dashboardSnapshot("2026-10-04",NOW);
});
after(()=>setNowForTests(null));

test("read admission protects natural phrasing without swallowing explicit work requests",()=>{
 for(const text of ["看一下目前每天的时间安排","帮我看看明天的课表","我想查看本周时间安排","你能不能看一下我的项目进展","我还有多少时间可以学","现在哪些任务没完成","我今天学了多久","查看一下这个东西"])assert.equal(isReadRequest(text),true,text);
 for(const text of ["明天花一小时查看实验结果","安排我明天查看课表","创建一个查看课表的任务","我想做一个查看课表的网站","提醒我查看成绩","导入这份课表"])assert.equal(isReadRequest(text),false,text);
});

test("reported screenshot query reads seven days, including real blocks; never invokes the task classifier",async()=>{
 const before=facts(),calls=modelCalls;const r=await say("看一下目前每天的时间安排");
 assert.equal(r.state,"answered");assert.match(r.summary,/2026-10-04/);assert.match(r.summary,/2026-10-10/);assert.match(r.summary,/15:00–15:40 学习安排：实验基线/);
 assert.equal(r.undo.available,false);assert.deepEqual(r.changes,[]);assert.deepEqual(r.followUps,[]);assert.ok(r.links.some(l=>l.href==="/week"));
 assert.equal(modelCalls,calls);assert.deepEqual(facts(),before);
});

test("view and process modes, question phrasing and gap context all stay read-only",async()=>{
 const before=facts();
 for(const text of ["/查看 本周时间安排","/查看","/处理 看一下目前每天的时间安排","现在每天怎么安排的","帮我看看明天的课表","/查看 看不懂的范围"]){
  const r=await say(text,{slot:{date:"2026-10-05",start:"16:00",end:"17:00"}});assert.equal(r.state,"answered",JSON.stringify(r));assert.equal(r.undo.available,false);assert.deepEqual(r.changes,[]);
 }
 assert.deepEqual(facts(),before);assert.equal(modelCalls,0);
});

test("querying budgets, tasks, progress, policy and reminders reads current facts without approving defaults",async()=>{
 const before=facts();
 for(const [text,expected] of [["我还有多少时间可以学",/学习预算不等于全部自由时间/],["现在哪些任务没完成",/实验基线/],["/查看 项目进展",/最近实践/],["/查看 作息规则",/这里只读取设置/],["/查看 提醒状态",/提醒/]] as const){const r=await say(text);assert.equal(r.state,"answered");assert.match(r.summary,expected);}
 assert.deepEqual(facts(),before);
});

test("view mode never executes embedded mutations; unclear scope asks instead of making a task",async()=>{
 const before=facts();const r=await say("/查看 把这段改到明天下午");assert.equal(r.state,"answered");assert.match(r.summary,/没有创建任务或修改安排/);assert.deepEqual(facts(),before);
});

test("explicit scheduling and plain future work remain available even with 查看 in the title",async()=>{
 const r=await say("/安排 查看论文结果",{slot:{date:"2026-10-06",start:"15:00",end:"16:00"}});assert.equal(r.state,"applied");assert.ok(getDb().prepare("SELECT id FROM tasks WHERE title='查看论文结果'").get());
 const id=crypto.randomUUID();getDb().prepare("INSERT INTO tasks (id,title,description,status,priority,due_kind,created_at,updated_at) VALUES (?,'其他事项','','todo','normal','none',?,?)").run(id,NOW.toISOString(),NOW.toISOString());
 const detail=await say("/查看 这项任务的状态",{selectedEntityRef:{kind:"task",id}});assert.equal(detail.state,"answered");assert.match(detail.summary,/其他事项/);assert.doesNotMatch(detail.summary,/查看论文结果/);
});
