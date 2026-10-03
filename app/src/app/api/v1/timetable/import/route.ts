import type { NextRequest } from 'next/server';
import { requireOwner } from '@/workflows/auth-guard';
import { timetableImportSchema } from '@/contracts/timetable';
import { importTimetable } from '@/repositories/timetable';
import { TimetableError } from '@/domain/timetable';
import { errorResponse, parseJson, runIdempotent } from '@/workflows/http';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const raw = await request.text(), json = parseJson(raw); if (!json.ok) return json.response;
  const parsed = timetableImportSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse('VALIDATION', parsed.error.issues.map(i => i.message).join('；'), 422);
  try {
    return runIdempotent(request, raw, { actorScope: `owner:${auth.session.ownerId}`, route: 'timetable.import', execute: () => {
      const result = importTimetable(parsed.data, parsed.data.expectedRevision);
      return { statusCode: 201, body: result, resourceType: 'timetable', resourceId: null };
    } });
  } catch (e) { if (e instanceof TimetableError) return errorResponse('VALIDATION', e.message, 422); throw e; }
}
