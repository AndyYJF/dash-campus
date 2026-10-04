import type { NextRequest } from 'next/server';
import { requireOwner } from '@/workflows/auth-guard';
import { timetableImportSchema } from '@/contracts/timetable';
import { TimetableError } from '@/domain/timetable';
import { getDb } from '@/repositories/db';
import { getInstanceState } from '@/repositories/instance';
import { getPlanningRevision } from '@/repositories/proposals';
import { executeOperation } from '@/workflows/commands';
import { errorResponse, parseJson, runIdempotent } from '@/workflows/http';
export const dynamic = 'force-dynamic';

/**
 * 兼容入口：设置页的“导入课表”。和统一输入走同一个注册操作（upsert_course_set）——
 * 课程进入语义层、写变更记录可撤销、随后重排；不再另写一份没有课程资料的固定活动。响应形状不变。
 */
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const raw = await request.text(), json = parseJson(raw); if (!json.ok) return json.response;
  const parsed = timetableImportSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse('VALIDATION', parsed.error.issues.map(i => i.message).join('；'), 422);
  try {
    return runIdempotent(request, raw, { actorScope: `owner:${auth.session.ownerId}`, route: 'timetable.import', execute: () => {
      if (getPlanningRevision() !== parsed.data.expectedRevision) return { statusCode: 409, body: { error: { code: 'CONFLICT', message: '课程或计划已发生变化，请重新预览课表' } }, resourceType: null, resourceId: null };
      const ids = () => new Set((getDb().prepare('SELECT id FROM fixed_events').all() as Array<{ id: string }>).map(r => r.id));
      const before = ids();
      const out = executeOperation(
        { command: 'upsert_course_set', sdctText: parsed.data.text, firstMonday: parsed.data.firstMonday, timezone: parsed.data.timezone },
        { intakeId: null, itemId: null, itemKey: '', instanceEpoch: getInstanceState().deploymentEpoch, evidence: '设置页导入课表', explicit: true },
      );
      if (!out.result.ok) return { statusCode: out.result.code === 'VALIDATION' ? 422 : 409, body: { error: { code: out.result.code, message: out.result.error } }, resourceType: null, resourceId: null };
      const created = [...ids()].filter(id => !before.has(id));
      const total = (getDb().prepare(`SELECT COUNT(*) AS n FROM course_meeting_projections p JOIN course_meetings m ON m.id = p.meeting_id JOIN courses c ON c.id = m.course_id JOIN course_sets s ON s.id = c.course_set_id WHERE s.status = 'active'`).get() as { n: number }).n;
      return { statusCode: 201, body: { created: created.length, skipped: Math.max(0, total - created.length), ids: created, planningRevision: getPlanningRevision(), batchId: out.result.batchId, summary: out.result.summary }, resourceType: 'timetable', resourceId: null };
    } });
  } catch (e) { if (e instanceof TimetableError) return errorResponse('VALIDATION', e.message, 422); throw e; }
}
