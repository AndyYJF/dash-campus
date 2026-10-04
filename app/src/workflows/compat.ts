import { getDb } from "@/repositories/db";
import { addChange, createBatch } from "@/repositories/journal";
import { getInstanceState } from "@/repositories/instance";
import { COMMAND_POLICY_VERSION } from "@/contracts/commands";

/**
 * 旧表单（v1 接口）对任务的写入也进同一份变更记录（AGENT-INTERFACE-CONTRACT §6）：
 * 行为与校验仍是原接口的，这里只在同一事务里记下改了什么，于是“最近变化”看得到、统一入口撤得掉，
 * 撤销时同样按版本核对，不覆盖之后的修改。随后的学习安排对账由 worker 按待对账标记补上。
 */

type Row = Record<string, unknown>;
/** 不进变更记录的列：版本与时间戳由撤销逻辑自己维护 */
const SKIP = new Set(["id", "version", "updated_at", "created_at", "reminder_revision"]);
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

function taskRow(id: string): Row | undefined {
  return getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as Row | undefined;
}

/** 在一个事务里执行旧接口的任务写入并记账；write 返回任务 id（失败时返回 null，不记账） */
export function journaledTaskWrite<T>(taskId: string | null, write: () => T, idOf: (result: T) => string | null): T {
  return getDb()
    .transaction((): T => {
      const before = taskId ? taskRow(taskId) : undefined;
      const result = write();
      const id = idOf(result);
      if (!id) return result;
      const after = taskRow(id);
      if (!after) return result;
      const title = String(after.title ?? "");
      if (!before) {
        const batchId = createBatch({ command: "create_or_update_task", reason: `任务创建：${title}（编辑表单）`, intakeId: null, itemId: null, policyVersion: COMMAND_POLICY_VERSION, instanceEpoch: getInstanceState().deploymentEpoch });
        addChange(batchId, { entityKind: "task", entityId: id, action: "create", after: { title }, afterVersion: after.version as number });
        return result;
      }
      const changed = Object.keys(after).filter((k) => !SKIP.has(k) && after[k] !== before[k]);
      if (!changed.length) return result;
      const archived = changed.includes("archived_at") && after.archived_at != null;
      const batchId = createBatch({
        command: archived ? "archive_entity" : "create_or_update_task",
        reason: `${archived ? "任务归档" : after.status === "done" && before.status !== "done" ? "任务完成" : "任务修改"}：${title}（编辑表单）`,
        intakeId: null,
        itemId: null,
        policyVersion: COMMAND_POLICY_VERSION,
        instanceEpoch: getInstanceState().deploymentEpoch,
      });
      addChange(batchId, {
        entityKind: "task",
        entityId: id,
        action: "update",
        before: Object.fromEntries(changed.map((k) => [camel(k), before[k]])),
        after: Object.fromEntries(changed.map((k) => [camel(k), after[k]])),
        beforeVersion: before.version as number,
        afterVersion: after.version as number,
      });
      return result;
    })
    .immediate();
}
