import assert from "node:assert/strict";
import { before,test } from "node:test";
import { migrateAll,getDb } from "./helpers";
import { detailedOccurrences,occurrences } from "@/domain/calendar-occurrences";
import { resolveWallTime } from "@/domain/time";
before(migrateAll);
const base={id:"dst-rule",title:"学习",version:2,weekday:7,localStart:"02:15",localEnd:"03:30",timezone:"America/New_York",validFrom:null,validUntil:null};
test("周期展开保留夏令时标记，唯一键包含规则版本、当地日期及选择的偏移",()=>{
 const first=detailedOccurrences(base,Date.parse("2026-03-08T05:00:00Z"),Date.parse("2026-03-09T04:00:00Z"))[0];
 assert.equal(first.start,"2026-03-08T07:00:00.000Z");assert.equal(first.startAdjustment,"gap_shifted");assert.equal(first.startOffsetMinutes,-240);assert.equal(first.ruleVersion,2);
 assert.notEqual(detailedOccurrences({...base,version:3},Date.parse(first.start),Date.parse(first.end))[0].key,first.key);
 const overlap=detailedOccurrences({...base,localStart:"01:30",localEnd:"02:30"},Date.parse("2026-11-01T04:00:00Z"),Date.parse("2026-11-02T05:00:00Z"))[0];assert.equal(overlap.startAdjustment,"overlap_earlier");assert.equal(overlap.start,"2026-11-01T05:30:00.000Z");assert.equal(overlap.startOffsetMinutes,-240);assert.equal(overlap.endOffsetMinutes,-300);
});
test("不存在时段完全坍缩时仍可解释，不能产生负容量或排程冲突",()=>{
 const row={...base,localEnd:"02:45"},start=Date.parse("2026-03-08T05:00:00Z"),end=Date.parse("2026-03-09T04:00:00Z");assert.equal(detailedOccurrences(row,start,end)[0].collapsed,true);assert.deepEqual(occurrences(row,start,end),[]);
 assert.equal(resolveWallTime("2026-03-08","02:15",base.timezone).instant.toISOString(),"2026-03-08T07:00:00.000Z");
});
test("单日例外修订产生新 occurrence 身份，取消后不再占用容量",()=>{
 const db=getDb();db.prepare("INSERT INTO fixed_events(id,title,weekday,local_start,local_end,timezone,version) VALUES('exception-rule','活动',7,'09:00','10:00','Asia/Shanghai',1)").run();
 const row={...base,id:"exception-rule",version:1,localStart:"09:00",localEnd:"10:00",timezone:"Asia/Shanghai",eventDate:null},start=Date.parse("2026-10-03T16:00:00Z"),end=Date.parse("2026-10-04T16:00:00Z"),original=detailedOccurrences(row,start,end)[0];
 db.prepare("INSERT INTO fixed_event_exceptions(event_id,local_date,cancelled,local_start,local_end) VALUES('exception-rule','2026-10-04',0,'10:00','11:00')").run();const revised=detailedOccurrences(row,start,end)[0];assert.notEqual(revised.key,original.key);assert.equal(revised.exceptionVersion,1);
 db.prepare("UPDATE fixed_event_exceptions SET cancelled=1,version=version+1 WHERE event_id='exception-rule'").run();assert.deepEqual(occurrences(row,start,end),[]);
});
