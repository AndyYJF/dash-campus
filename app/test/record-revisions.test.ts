import assert from "node:assert/strict";
import { before, test } from "node:test";
import { NextRequest } from "next/server";
import { migrateAll,getDb } from "./helpers";
import { createOwner,createSession,SESSION_COOKIE } from "@/domain/session";
import { createProject,createTask } from "@/repositories/planning";
import { createLog,getLog,listLogs,updateLog,recordRevisions,createArtifact,updateArtifact,archiveArtifact,getArtifact } from "@/repositories/logs";
import { createResource,getResource,updateResource,resourceRevisions,listResources } from "@/repositories/resources";
import { resourceCreateSchema } from "@/contracts/records";
import { GET as getLogApi,PATCH as patchLog,DELETE as deleteLog } from "@/app/api/v1/logs/[id]/route";
import { POST as postResource } from "@/app/api/v1/resources/route";
import { GET as getResourceApi,PATCH as patchResource } from "@/app/api/v1/resources/[id]/route";
import { POST as postFixed } from "@/app/api/v1/fixed-events/route";
import { PATCH as patchFixed } from "@/app/api/v1/fixed-events/[id]/route";
import { POST as postException } from "@/app/api/v1/fixed-events/[id]/exceptions/route";
import { setProvidersForTests } from "@/integrations";
import { fixtureModelProvider } from "@/integrations/fixtures";
import { startExploration,runExplorationJob } from "@/workflows/exploration";
import { claimDueJobs } from "@/repositories/jobs";
import { createProposal } from "@/repositories/proposals";
import { translateProposals,fingerprint } from "@/workflows/ai-proposals";
import { rejectProposal } from "@/repositories/proposal-decisions";
import { proposalProblem } from "@/repositories/proposal-validity";
import { applyProposal } from "@/workflows/apply-proposal";

before(()=>{migrateAll();createOwner("unused-test-hash");setProvidersForTests({model:{provider:fixtureModelProvider(),mode:"fixture"},search:null});});
function log(){const input={clientEntryId:crypto.randomUUID(),occurredOn:"2026-10-03",progress:"原始进展",blocker:"原卡点",taskId:null,projectId:null};const r=createLog(input);assert.notEqual(r,"content_conflict");if(r==="content_conflict")throw Error();return {input,log:r.log};}
function resource(){return createResource(resourceCreateSchema.parse({kind:"text",title:"资料",body:"原文可引用。",sourceKind:"official",sourceYear:2026}));}
function ctx(id:string){return {params:Promise.resolve({id})};}
function request(method:string,body?:unknown,csrf=true,key?:string){const {session,token}=createSession();return new NextRequest("http://localhost/api/v1/test",{method,headers:{cookie:`${SESSION_COOKIE}=${token}`,"x-csrf-token":csrf?session.csrfToken:"wrong",...(key?{"Idempotency-Key":key}:{})},...(method!=="GET"?{body:JSON.stringify(body)}:{})});}

test("日志修订与归档保留原文；原离线请求迟到重放不覆盖编辑后的正文",()=>{
 const {input,log:l}=log();const updated=updateLog(l.id,{progress:"修订进展"},1);assert.ok(typeof updated!=="string");assert.equal(updated.version,2);
 assert.equal(updateLog(l.id,{blocker:"覆盖"},1),"conflict");
 const replay=createLog(input);assert.ok(typeof replay!=="string");assert.equal(replay.log.progress,"修订进展");assert.equal(replay.replayed,true);
 assert.equal(createLog({...input,progress:"不同初稿"}),"content_conflict");
 const archived=updateLog(l.id,{},2,true);assert.ok(typeof archived!=="string");assert.ok(archived.archivedAt);assert.ok(!listLogs().some(r=>r.id===l.id));
 assert.equal(getLog(l.id)?.version,3);assert.equal(recordRevisions("log",l.id)[2].snapshot.progress,"原始进展");
 assert.equal(updateLog(l.id,{progress:"改归档"},3),"not_found");assert.ok(typeof createLog(input)!=="string");
});
test("记录与版本原子提交：版本写入失败不能留下无历史的记录或半份修订",()=>{
 const db=getDb(),{log:l}=log();db.exec("CREATE TRIGGER reject_log_revision BEFORE INSERT ON daily_log_revisions BEGIN SELECT RAISE(ABORT,'revision failure'); END");
 try{const count=(db.prepare("SELECT COUNT(*) n FROM daily_logs").get() as {n:number}).n;assert.throws(()=>log(),/revision failure/);assert.equal((db.prepare("SELECT COUNT(*) n FROM daily_logs").get() as {n:number}).n,count);assert.throws(()=>updateLog(l.id,{progress:"不可提交"},1),/revision failure/);assert.equal(getLog(l.id)?.progress,l.progress);assert.equal(getLog(l.id)?.version,1);}finally{db.exec("DROP TRIGGER reject_log_revision");}
});
test("日志 API 登录/CSRF/版本/有效日期；空白修订失败且归档后历史仍可读取",async()=>{
 const {log:l}=log();assert.equal((await patchLog(new NextRequest("http://localhost",{method:"PATCH"}),ctx(l.id))).status,401);
 assert.equal((await patchLog(request("PATCH",{expectedVersion:1,progress:"x"},false),ctx(l.id))).status,403);
 assert.equal((await patchLog(request("PATCH",{progress:"x"}),ctx(l.id))).status,422);
 assert.equal((await patchLog(request("PATCH",{expectedVersion:1,occurredOn:"2026-02-30"}),ctx(l.id))).status,422);
 assert.equal((await patchLog(request("PATCH",{expectedVersion:1,progress:"",blocker:" "}),ctx(l.id))).status,422);
 assert.equal((await patchLog(request("PATCH",{expectedVersion:1,progress:"保存"}),ctx(l.id))).status,200);
 assert.equal((await patchLog(request("PATCH",{expectedVersion:1,progress:"旧版本"}),ctx(l.id))).status,409);
 assert.equal((await deleteLog(request("DELETE",{expectedVersion:2}),ctx(l.id))).status,200);
 const r=await getLogApi(request("GET"),ctx(l.id));assert.equal(r.status,200);assert.equal((await r.json()).revisions.length,3);
});
test("成果修订和归档都保留版本；旧版更新失败且不篡改原关联与正文",()=>{
 const p=createProject({title:"测试项目",question:"",expectedOutcome:"",prerequisites:"",reviewQuestions:"",goalIds:[]});
 const a=createArtifact({projectId:p.id,logId:null,kind:"text",title:"原成果",body:"基线记录",url:null});assert.ok(typeof a!=="string");
 const u=updateArtifact(a.id,{title:"新成果"},1);assert.ok(typeof u!=="string");assert.equal(u.projectId,p.id);assert.equal(updateArtifact(a.id,{body:"覆盖"},1),"conflict");
 assert.throws(()=>updateArtifact(a.id,{kind:"link",url:null},2),/链接成果/);
 const archived=archiveArtifact(a.id,2);assert.ok(typeof archived!=="string");assert.equal(getArtifact(a.id)?.version,3);assert.equal(recordRevisions("artifact",a.id)[2].snapshot.title,"原成果");
});
test("资料版本引用不可变：编辑和归档不会重写已入队探索的正文、哈希和来源性质",()=>{
 const r=resource(),initial=resourceRevisions(r.id)[0];
 const run=startExploration({query:"实践问题",background:"",projectId:null,topicId:null,materials:[],resourceIds:[r.id]});assert.ok(run.ok);
 const db=getDb(),ev=db.prepare("SELECT e.id,e.text,e.status,r.resource_version,r.content_hash FROM evidence_documents e JOIN evidence_resource_refs r ON r.evidence_id=e.id WHERE e.run_id=?").get(run.run.id) as {text:string;status:string;resource_version:number;content_hash:string};
 assert.equal(ev.text,r.body);assert.equal(ev.status,"user_supplied");assert.equal(ev.resource_version,1);assert.equal(ev.content_hash,initial.contentHash);
 assert.ok(typeof updateResource(r.id,{body:"修订后的原文"},1)!=="string");assert.equal(updateResource(r.id,{title:"冲突"},1),"conflict");
 assert.ok(typeof updateResource(r.id,{},2,true)!=="string");assert.equal(resourceRevisions(r.id).length,3);assert.ok(!listResources().some(v=>v.id===r.id));
 assert.deepEqual(db.prepare("SELECT e.id,e.text,e.status,r.resource_version,r.content_hash FROM evidence_documents e JOIN evidence_resource_refs r ON r.evidence_id=e.id WHERE e.run_id=?").get(run.run.id),ev);
 const bad=startExploration({query:"q",background:"",projectId:null,topicId:null,materials:[],resourceIds:[r.id]});assert.ok(!bad.ok&&bad.code==="INVALID_REFERENCE");
 const url=createResource(resourceCreateSchema.parse({kind:"url",title:"链接",url:"https://example.org/doc"}));assert.ok(!startExploration({query:"q",background:"",projectId:null,topicId:null,materials:[],resourceIds:[url.id]}).ok);
 assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
});
test("资料 API 创建重试幂等；局部修订保留来源年份和URL，不用缺省值清空",async()=>{
 const input={kind:"url",title:"已保存资料",body:"引用内容",url:"https://example.org/a",sourceYear:2026,sourceKind:"official"};const key=crypto.randomUUID();
 const one=await postResource(request("POST",input,true,key));assert.equal(one.status,201);const r=(await one.json()).resource;
 const again=await postResource(request("POST",input,true,key));assert.equal(again.status,201);assert.equal((await again.json()).resource.id,r.id);
 assert.equal((await patchResource(request("PATCH",{expectedVersion:1,title:"新标题"}),ctx(r.id))).status,200);
 const saved=getResource(r.id)!;assert.equal(saved.sourceYear,2026);assert.equal(saved.url,input.url);assert.equal(saved.body,input.body);
 assert.equal((await getResourceApi(request("GET"),ctx(r.id))).status,200);
 assert.equal((await patchResource(request("PATCH",{expectedVersion:2,url:"javascript:alert(1)"}),ctx(r.id))).status,422);
});
test("旧提案冷却指纹兼容；修订提供新证据；模型调用前版本使过期建议无法应用",()=>{
 const {log:l}=log(),task=createTask({title:"任务",description:"",projectId:null,goalId:null,status:"todo",priority:"normal",estimateMinutes:null,plannedWeek:null,scheduledStart:null,scheduledEnd:null,due:{kind:"none"}});
 const model={reason:"记录建议",evidenceIds:[l.id],operations:[{kind:"set_task_status" as const,taskId:task.id,status:"doing" as const}]};
 const base={evidenceIds:new Set([l.id]),taskIds:new Set([task.id]),projectIds:new Set<string>(),projectId:null,sourceKind:"assistant" as const,sourceId:"test",groupId:crypto.randomUUID(),groupTitle:"测试",inputVersions:{[`log:${l.id}`]:1,[`task:${task.id}`]:task.version}};
 const first=translateProposals([model],base).created[0];assert.equal(first.evidenceFingerprint,fingerprint(null,model.operations,model.evidenceIds));assert.equal(rejectProposal(first.id,"not_useful"),"ok");
 assert.equal(translateProposals([model],base).created.length,0);
 updateLog(l.id,{blocker:"新卡点"},1);
 const stale=translateProposals([model],{...base,ignoreCooldown:true}).created[0];assert.equal(proposalProblem(stale)?.code,"CONFLICT");assert.ok(!applyProposal(stale.id).ok);
 const fresh=translateProposals([model],{...base,inputVersions:{...base.inputVersions,[`log:${l.id}`]:2}}).created[0];assert.ok(fresh);assert.notEqual(fresh.evidenceFingerprint,first.evidenceFingerprint);assert.equal(proposalProblem(fresh),null);
});
test("规范固定活动 API 与现有日历共享版本和例外，不绕过 CSRF",async()=>{
 const input={title:"固定活动",weekday:1,localStart:"09:00",localEnd:"10:00",timezone:"Asia/Shanghai",validFrom:null,validUntil:null,eventDate:null};
 const created=await postFixed(request("POST",input,true,crypto.randomUUID()));assert.equal(created.status,201);const {id}=await created.json();
 assert.equal((await patchFixed(request("PATCH",{...input,title:"调整",expectedVersion:1}),ctx(id))).status,200);
 assert.equal((await patchFixed(request("PATCH",{...input,expectedVersion:1}),ctx(id))).status,409);
 const exception={localDate:"2026-10-05",cancelled:true,expectedVersion:0};
 assert.equal((await postException(request("POST",exception,false),ctx(id))).status,403);
 assert.equal((await postException(request("POST",exception),ctx(id))).status,200);
 assert.equal((await postException(request("POST",exception),ctx(id))).status,409);
});
test("升级前仅有记录 ID 的旧建议按迁移基线检查，首次修订后不得应用",()=>{
 const {log:l}=log(),t=createTask({title:"旧建议任务",description:"",projectId:null,goalId:null,status:"todo",priority:"normal",estimateMinutes:null,plannedWeek:null,scheduledStart:null,scheduledEnd:null,due:{kind:"none"}});
 const p=createProposal({reason:"旧建议",contextRefs:[l.id],inputVersions:{},operations:[{kind:"set_task_status",taskId:t.id,expectedVersion:1,status:"done"}]});assert.equal(proposalProblem(p),null);
 updateLog(l.id,{progress:"新的进展"},1);assert.equal(proposalProblem(p)?.code,"CONFLICT");assert.ok(!applyProposal(p.id).ok);
});
test("无搜索的 fixture 可用已保存资料完成探索，标识仍为示例，归档后的旧原文可引用",async()=>{
 const r=resource(),started=startExploration({query:"资料探索",background:"",projectId:null,topicId:null,materials:[],resourceIds:[r.id]});assert.ok(started.ok);
 updateResource(r.id,{body:"修改正文"},1);updateResource(r.id,{},2,true);
 const job=claimDueJobs(new Date().toISOString(),100).find(j=>j.id===started.jobId);assert.ok(job);assert.equal((await runExplorationJob(job)).kind,"done");
 assert.ok((getDb().prepare("SELECT COUNT(*) n FROM candidates WHERE run_id=?").get(started.run.id) as {n:number}).n>0);
 assert.equal((getDb().prepare("SELECT integration_mode FROM exploration_runs WHERE id=?").get(started.run.id) as {integration_mode:string}).integration_mode,"fixture");
 assert.equal((getDb().prepare("SELECT text FROM evidence_documents WHERE run_id=?").get(started.run.id) as {text:string}).text,r.body);
});
