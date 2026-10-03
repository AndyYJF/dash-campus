import { NextResponse, type NextRequest } from 'next/server';
import { requireOwner } from '@/workflows/auth-guard';
import { timetableInputSchema } from '@/contracts/timetable';
import { previewTimetable } from '@/repositories/timetable';
import { TimetableError } from '@/domain/timetable';
import { errorResponse, parseJson } from '@/workflows/http';
export const dynamic = 'force-dynamic';
export async function POST(request: NextRequest) {
  const auth = requireOwner(request); if (!auth.ok) return auth.response;
  const json = parseJson(await request.text()); if (!json.ok) return json.response;
  const parsed = timetableInputSchema.safeParse(json.value);
  if (!parsed.success) return errorResponse('VALIDATION', parsed.error.issues.map(i => i.message).join('；'), 422);
  try { return NextResponse.json(previewTimetable(parsed.data)); }
  catch (e) { if (e instanceof TimetableError) return errorResponse('VALIDATION', e.message, 422); throw e; }
}
