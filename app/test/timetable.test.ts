import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { NextRequest } from 'next/server';
import { migrateAll, getDb } from './helpers';
import { parseTimetable } from '@/domain/timetable';
import { previewTimetable, importTimetable } from '@/repositories/timetable';
import { getPlanningRevision } from '@/repositories/proposals';
import { listFixedEvents } from '@/domain/workload';
import { occurrences } from '@/domain/calendar-occurrences';
import { addDays, wallTimeToUtc } from '@/domain/time';
import { runIdempotent } from '@/workflows/http';

before(migrateAll);
const text = 'SDCT1\nT=18\nP=1,08:15-09:00;2,09:10-09:55;3,10:15-11:00\nC=测试课程|教师|教室|5|1-2|6,10|A|-';
const input = { text, firstMonday: '2026-09-07', timezone: 'Asia/Shanghai' };
test('离散第6/10周保持准确日期，不在中间教学周生成活动', () => {
  const p = previewTimetable(input);
  assert.equal(p.ruleCount, 2); assert.equal(p.occurrenceCount, 2);
  assert.deepEqual(p.courses[0].dates, ['2026-10-16', '2026-11-13']);
  assert.equal(p.courses[0].rules[0].localEnd, '09:55');
  assert.equal(p.courses[0].rules[0].title, '测试课程 · 教师 · 教室');
  assert.equal(listFixedEvents().length, 0);
  const revision = getPlanningRevision(), imported = importTimetable(input, revision);
  assert.equal(imported.created, 2); assert.equal(imported.planningRevision, revision + 1);
  for (const week of [5, 6, 7, 8, 9, 10, 11]) {
    const monday = addDays(input.firstMonday, (week - 1) * 7);
    const count = listFixedEvents().flatMap(r => occurrences(r, wallTimeToUtc(monday, '00:00', input.timezone).getTime(), wallTimeToUtc(addDays(monday, 7), '00:00', input.timezone).getTime())).length;
    assert.equal(count, [6, 10].includes(week) ? 1 : 0);
  }
});
test('相同课表重复导入跳过，预览版本过期拒绝且无部分新增', () => {
  const p = previewTimetable(input);
  assert.equal(p.newRules, 0); assert.equal(p.duplicateRules, 2);
  const r = importTimetable(input, p.planningRevision);
  assert.equal(r.created, 0); assert.equal(r.skipped, 2); assert.equal(r.planningRevision, p.planningRevision);
  assert.throws(() => importTimetable({ ...input, text: text.replace('测试课程', '新课程') }, p.planningRevision - 1), /重新预览/);
  assert.equal(listFixedEvents().length, 2);
});
test('单双周、离散节次分别生成规则，不占中间节次或错误周', () => {
  const p = parseTimetable({ ...input, text: text.replace('1-2|6,10|A', '1,3|3-8|O') });
  assert.deepEqual(p.courses[0].weeks, [3, 5, 7]); assert.equal(p.ruleCount, 6); assert.equal(p.occurrenceCount, 6);
  assert.deepEqual(p.courses[0].rules.map(r => r.localStart), ['08:15', '08:15', '08:15', '10:15', '10:15', '10:15']);
  const even = parseTimetable({ ...input, text: text.replace('6,10|A', '3-8|E') });
  assert.deepEqual(even.courses[0].weeks, [4, 6, 8]);
});
test('错误日期/周次/节次/未知字段均拒绝，全部校验后才写数据库', () => {
  const invalid = [
    { ...input, firstMonday: '2026-09-08' }, { ...input, firstMonday: '2026-02-30' },
    { ...input, text: text.replace('6,10', '0,10') }, { ...input, text: text.replace('6,10', '19') },
    { ...input, text: text.replace('|1-2|', '|4|') }, { ...input, text: text.replace('|A|-', '|X|-') },
    { ...input, text: text.replace('|A|-', '|A|调课') }, { ...input, text: `${text}\nX=unknown` },
    { ...input, text: text.replace('09:10-09:55', '08:30-09:55') },
    { ...input, text: `${text}\nC=错误|教师|教室|8|1|1|A|-` },
  ];
  const beforeCount = listFixedEvents().length, beforeRevision = getPlanningRevision();
  for (const candidate of invalid) assert.throws(() => importTimetable(candidate, beforeRevision));
  assert.equal(listFixedEvents().length, beforeCount); assert.equal(getPlanningRevision(), beforeRevision);
});
test('事务中途失败整体回滚，重试幂等键回放原响应而非再导入', async () => {
  const candidate = { ...input, text: text.replace('测试课程', '事务课程') }, revision = getPlanningRevision();
  const db = getDb();
  db.exec("CREATE TRIGGER fail_timetable BEFORE INSERT ON fixed_events WHEN NEW.valid_from='2026-11-13' BEGIN SELECT RAISE(ABORT,'synthetic import failure'); END");
  assert.throws(() => importTimetable(candidate, revision), /synthetic import failure/);
  db.exec('DROP TRIGGER fail_timetable');
  assert.equal(listFixedEvents().length, 2); assert.equal(getPlanningRevision(), revision);
  const body = JSON.stringify({ ...candidate, expectedRevision: revision });
  const request = () => new NextRequest('http://localhost/api/v1/timetable/import', { method: 'POST', headers: { 'idempotency-key': 'same-timetable-request' }, body });
  const args = { actorScope: 'test-owner', route: 'timetable.import', execute: () => ({ statusCode: 201, body: importTimetable(candidate, revision), resourceType: 'timetable', resourceId: null }) };
  const first = await runIdempotent(request(), body, args).json();
  const replay = await runIdempotent(request(), body, args).json();
  assert.deepEqual(replay, first); assert.equal(listFixedEvents().length, 4); assert.equal(getPlanningRevision(), revision + 1);
});
