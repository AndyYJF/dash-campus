import { listAvailabilityBlocks, listFixedEvents } from './workload';
import { occurrences } from './calendar-occurrences';
import type { TaskRow } from '@/repositories/planning';

type Slot = { id?: string; title?: string; status?: string; scheduledStart: string | null; scheduledEnd: string | null };
export type ScheduleIssue = { code: string; message: string };

export function slotRange(task: Slot): [number, number] | null {
  if (!task.scheduledStart) return null;
  const start = new Date(task.scheduledStart).getTime();
  const end = task.scheduledEnd ? new Date(task.scheduledEnd).getTime() : start + 60_000;
  return [start, end];
}

export function fixedEventClash(start: string | null, end: string | null): string | null {
  const range = slotRange({ scheduledStart: start, scheduledEnd: end });
  if (!range || !Number.isFinite(range[0]) || !Number.isFinite(range[1]) || range[1] <= range[0] || range[1] - range[0] > 7 * 86400_000) return null;
  for (const row of listFixedEvents()) {
    if (occurrences(row, ...range).some(([s, e]) => range[0] < e && range[1] > s)) return row.title;
  }
  return null;
}

export function scheduleProblem(start: string | null, end: string | null): string | null {
  if (end && !start) return '只有结束时间没有开始时间';
  if ((start && !Number.isFinite(new Date(start).getTime())) || (end && !Number.isFinite(new Date(end).getTime()))) return '计划时刻不合法';
  if (start && end && new Date(end).getTime() <= new Date(start).getTime()) return '结束时间必须晚于开始时间';
  if (start && end && new Date(end).getTime() - new Date(start).getTime() > 7 * 86400_000) return '单项时段不能超过七天，请拆分任务';
  return null;
}

export function scheduleIssues(task: Slot, others: Slot[]): ScheduleIssue[] {
  const invalid = scheduleProblem(task.scheduledStart, task.scheduledEnd);
  if (invalid) return [{ code: 'VALIDATION', message: invalid }];
  const range = slotRange(task);
  if (!range || task.status === 'done' || task.status === 'cancelled') return [];
  const result: ScheduleIssue[] = [];
  const fixed = fixedEventClash(task.scheduledStart, task.scheduledEnd);
  if (fixed) result.push({ code: 'FIXED_EVENT_CONFLICT', message: `与固定安排「${fixed}」时间冲突` });
  const overlaps = others.filter(other => {
    if (other.id === task.id || other.status === 'done' || other.status === 'cancelled') return false;
    const slot = slotRange(other);
    return slot && range[0] < slot[1] && range[1] > slot[0];
  });
  if (overlaps.length) result.push({ code: 'TASK_TIME_CONFLICT', message: `与未完成任务${overlaps.slice(0,3).map(t => `「${t.title ?? t.id ?? '新任务'}」`).join('、')}的时段重叠` });
  const blocks = listAvailabilityBlocks();
  if (blocks.length) {
    const windows = blocks.flatMap(b => occurrences(b, ...range)).sort((a,b) => a[0]-b[0]);
    let cursor = range[0];
    for (const [s,e] of windows) { if (s > cursor) break; cursor = Math.max(cursor,e); }
    if (cursor < range[1]) result.push({ code: 'OUTSIDE_AVAILABILITY', message: '安排超出已配置的可用时间窗口' });
  }
  return result;
}

export function taskScheduleIssues(task: TaskRow, others: TaskRow[]) { return scheduleIssues(task, others); }
