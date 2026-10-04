import { getDb } from "@/repositories/db";
import { addChange, createBatch } from "@/repositories/journal";
import { getInstanceState } from "@/repositories/instance";
import { COMMAND_POLICY_VERSION } from "@/contracts/commands";

/**
 * 旧表单（v1 接口）的写入也进同一份变更记录（AGENT-INTERFACE-CONTRACT §6）：
 * 行为与校验仍是原接口的，这里只在同一事务里记下改了什么，于是“最近变化”看得到、统一入口撤得掉，
 * 撤销时同样按版本核对，不覆盖之后的修改。随后的学习安排对账由 worker 按待对账标记/规划修订号补上。
 */

type Row = Record<string, unknown>;
/** 不进变更记录的列：版本与时间戳由撤销逻辑自己维护 */
const SKIP = new Set(["id", "version", "updated_at", "created_at", "reminder_revision"]);
const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

type Kind = {
  table: string;
  entityKind: string;
  /** 给人看的对象名 */
  label: string;
  /** 记在批次上的操作名（决定最近变化里的中文标签） */
  command: string;
  /** 行被真正删除的表（固定活动）：删除记整行快照，撤销时原样恢复 */
  hardDelete?: boolean;
};

const KINDS = {
  task: { table: "tasks", entityKind: "task", label: "任务", command: "create_or_update_task" },
  goal: { table: "goals", entityKind: "goal", label: "目标", command: "upsert_goal" },
  project: { table: "projects", entityKind: "project", label: "项目", command: "update_project_state" },
  fixed_event: { table: "fixed_events", entityKind: "fixed_event", label: "固定活动", command: "update_fixed_event", hardDelete: true },
} satisfies Record<string, Kind>;

function rowOf(table: string, id: string): Row | undefined {
  return getDb().prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Row | undefined;
}

/**
 * 在一个事务里执行旧接口的写入并记账。
 * id：已有对象的 id（新建传 null）；idOf：从写入结果取对象 id，写入没成功（冲突/不存在）返回 null，不记账。
 */
export function journaledWrite<T>(kind: keyof typeof KINDS, id: string | null, write: () => T, idOf: (result: T) => string | null): T {
  const k: Kind = KINDS[kind];
  return getDb()
    .transaction((): T => {
      const before = id ? rowOf(k.table, id) : undefined;
      const result = write();
      const targetId = idOf(result);
      if (!targetId) return result;
      const after = rowOf(k.table, targetId);
      const batch = (reason: string, command = k.command) =>
        createBatch({ command, reason: `${reason}（编辑表单）`, intakeId: null, itemId: null, policyVersion: COMMAND_POLICY_VERSION, instanceEpoch: getInstanceState().deploymentEpoch });
      if (!after) {
        if (before && k.hardDelete) addChange(batch(`${k.label}删除：${String(before.title ?? "")}`), { entityKind: k.entityKind, entityId: targetId, action: "delete", before });
        return result;
      }
      const title = String(after.title ?? "");
      if (!before) {
        addChange(batch(`${k.label}创建：${title}`), { entityKind: k.entityKind, entityId: targetId, action: "create", after: { title }, afterVersion: (after.version as number | undefined) ?? null });
        return result;
      }
      const changed = Object.keys(after).filter((c) => !SKIP.has(c) && after[c] !== before[c]);
      if (!changed.length) return result;
      const archived = changed.includes("archived_at") && after.archived_at != null;
      const verb = archived ? "归档" : kind === "task" && after.status === "done" && before.status !== "done" ? "完成" : "修改";
      addChange(batch(`${k.label}${verb}：${title}`, archived ? "archive_entity" : k.command), {
        entityKind: k.entityKind,
        entityId: targetId,
        action: "update",
        before: Object.fromEntries(changed.map((c) => [camel(c), before[c]])),
        after: Object.fromEntries(changed.map((c) => [camel(c), after[c]])),
        beforeVersion: (before.version as number | undefined) ?? null,
        afterVersion: (after.version as number | undefined) ?? null,
      });
      return result;
    })
    .immediate();
}

export function journaledTaskWrite<T>(taskId: string | null, write: () => T, idOf: (result: T) => string | null): T {
  return journaledWrite("task", taskId, write, idOf);
}
