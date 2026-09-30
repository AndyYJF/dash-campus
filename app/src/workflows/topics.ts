import type { z } from "zod";
import { getDb } from "@/repositories/db";
import { getTopic, insertTopic, updateTopicRow, type TopicRow } from "@/repositories/exploration";
import type { topicCreateSchema, topicPatchSchema } from "@/contracts/exploration";
import { nextWeeklyRun } from "@/domain/exploration";
import { instanceTimezone } from "@/domain/time";
import { invalidateQueuedTopicRuns } from "@/workflows/exploration";

/**
 * 关注方向（定期探索订阅，计划 7.2）：用户明确开启并选择本地时间；
 * 停用或修改都增加版本，未开始的旧 run 失效，在途结果在发布前重检版本（F16）。
 */

export function createTopic(input: z.infer<typeof topicCreateSchema>): TopicRow {
  const tz = instanceTimezone();
  return insertTopic({
    ...input,
    timezone: tz,
    nextRunAt: input.enabled ? nextWeeklyRun(new Date(), input.weekday, input.localTime, tz) : null,
  });
}

export function updateTopic(
  id: string,
  input: z.infer<typeof topicPatchSchema>,
): TopicRow | "not_found" | "conflict" {
  const current = getTopic(id);
  if (!current || current.archivedAt) return "not_found";
  const { expectedVersion, ...patch } = input;
  const enabled = patch.enabled ?? current.enabled;
  const weekday = patch.weekday ?? current.weekday;
  const localTime = patch.localTime ?? current.localTime;
  const scheduleChanged =
    patch.enabled !== undefined || patch.weekday !== undefined || patch.localTime !== undefined;
  const db = getDb();
  const tx = db.transaction(() => {
    const updated = updateTopicRow(id, expectedVersion, {
      ...patch,
      ...(scheduleChanged
        ? { nextRunAt: enabled ? nextWeeklyRun(new Date(), weekday, localTime, current.timezone) : null }
        : {}),
    });
    if (!updated) return "conflict" as const;
    invalidateQueuedTopicRuns(id);
    return updated;
  });
  return tx();
}

export function archiveTopic(id: string, expectedVersion: number): TopicRow | "not_found" | "conflict" {
  const current = getTopic(id);
  if (!current || current.archivedAt) return "not_found";
  const db = getDb();
  const tx = db.transaction(() => {
    const updated = updateTopicRow(id, expectedVersion, {
      enabled: false,
      nextRunAt: null,
      archivedAt: new Date().toISOString(),
    });
    if (!updated) return "conflict" as const;
    invalidateQueuedTopicRuns(id);
    return updated;
  });
  return tx();
}
