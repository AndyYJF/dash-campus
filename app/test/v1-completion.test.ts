import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { migrateAll, getDb } from './helpers';
import { createTask, getTask, updateTask } from '@/repositories/planning';
import { createProposal, bumpPlanningRevision, getPlanningRevision } from '@/repositories/proposals';
import { applyProposal, fixedEventClash } from '@/workflows/apply-proposal';
import { HttpError } from '@/workflows/http';
import { createSource, getDecisionByRevision } from '@/repositories/inbox';
import { importNotice, resolveThisRevision } from '@/workflows/inbox';
import { noticeImportSchema } from '@/contracts/inbox';
before(migrateAll);
const base = { title:'t',description:'',projectId:null,goalId:null,status:'todo' as const,priority:'normal' as const,estimateMinutes:30,plannedWeek:null,scheduledStart:null,scheduledEnd:null,due:{kind:'none' as const} };

test('排程冲突：API底层与提案都拒绝重叠，显式覆盖保留原因',()=>{
 const a=createTask({...base,scheduledStart:'2026-10-03T11:00:00Z',scheduledEnd:'2026-10-03T12:00:00Z'});
 const b=createTask(base);
 const times={scheduledStart:a.scheduledStart,scheduledEnd:a.scheduledEnd};
 assert.throws(()=>updateTask(b.id,times,b.version),(e:unknown)=>e instanceof HttpError&&e.code==='TASK_TIME_CONFLICT');
 const p=createProposal({contextRefs:[],inputVersions:{},operations:[{kind:'reschedule_task',taskId:b.id,expectedVersion:b.version,...times}],reason:'audit'});
 const r=applyProposal(p.id);assert.ok(!r.ok&&r.code==='TASK_TIME_CONFLICT');
 const u=updateTask(b.id,{...times,planningOverrideReason:'两项可以同场同时开展'},b.version);
 assert.ok(typeof u==='object');assert.equal(u.planningOverrideReason,'两项可以同场同时开展');
 assert.equal(getTask(b.id)?.scheduledStart,a.scheduledStart);
});

test('跨日与固定活动：次日部分仍检出，取消单日活动后不冲突',()=>{
 getDb().prepare('INSERT INTO fixed_events (id,title,weekday,local_start,local_end,timezone,event_date) VALUES (?,?,?,?,?,?,?)').run('night','周日活动',7,'00:15','01:00','Asia/Shanghai','2026-10-04');
 assert.equal(fixedEventClash('2026-10-03T23:30:00+08:00','2026-10-04T01:00:00+08:00'),'周日活动');
 getDb().prepare('INSERT INTO fixed_event_exceptions (event_id,local_date,cancelled) VALUES (?,?,1)').run('night','2026-10-04');
 assert.equal(fixedEventClash('2026-10-03T23:30:00+08:00','2026-10-04T01:00:00+08:00'),null);
});

test('带时段create_task同样校验计划读集，同提案中新任务互撞会全量回滚',()=>{
 const input={...base,scheduledStart:'2026-10-06T11:00:00Z',scheduledEnd:'2026-10-06T12:00:00Z'};
 const p=createProposal({contextRefs:[],inputVersions:{},operations:[{kind:'create_task',clientRef:'one',input}],reason:''});
 bumpPlanningRevision();const stale=applyProposal(p.id);assert.ok(!stale.ok&&stale.code==='STALE_PLANNING');
 const q=createProposal({contextRefs:[],inputVersions:{},operations:[{kind:'create_task',clientRef:'two',input},{kind:'create_task',clientRef:'three',input}],reason:''});
 const before=(getDb().prepare('SELECT count(*) n FROM tasks').get() as {n:number}).n;
 const overlap=applyProposal(q.id);assert.ok(!overlap.ok&&overlap.code==='TASK_TIME_CONFLICT');
 assert.equal((getDb().prepare('SELECT count(*) n FROM tasks').get() as {n:number}).n,before);
});

test('版本冲突不得改变planningRevision',()=>{
 const t=createTask(base);updateTask(t.id,{title:'changed'},t.version);const rev=getPlanningRevision();
 assert.equal(updateTask(t.id,{scheduledStart:'2026-10-10T11:00:00Z'},t.version),'conflict');assert.equal(getPlanningRevision(),rev);
});

test('通知修订更新穿插人工纠正：旧修订返回冲突，未读新版本保持待确认',()=>{
 const source=createSource('audit','test');
 const envelope=(key:string,n:number)=>noticeImportSchema.parse({schemaVersion:1,source:'audit',externalId:'one',revisionKey:key,revisionOrder:n,occurredAt:new Date().toISOString(),text:'新通知'});
 const a=importNotice(envelope('r1',1),source.token),b=importNotice(envelope('r2',2),source.token);
 assert.ok(a.ok&&b.ok);
 assert.equal(resolveThisRevision(a.messageId,'folded',a.revisionId,1),'conflict');
 assert.equal(getDecisionByRevision(b.revisionId)?.manualPartition,null);
 assert.equal(resolveThisRevision(b.messageId,'folded',b.revisionId,1),'ok');
 assert.equal(resolveThisRevision(b.messageId,'info',b.revisionId,1),'conflict');
});
