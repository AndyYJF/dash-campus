import { getDb } from "@/repositories/db";

/**
 * 实例运行控制（计划 10.2）：restored_hold 由 restore 命令写入、resume 命令显式解除。
 * hold 期间 worker 不发起邮件、搜索、模型请求；Web 只读展示恢复摘要。
 */

export type InstanceState = {
  restoredHold: boolean;
  deploymentEpoch: number;
  restoredAt: string | null;
  restoredFrom: string | null;
  resumedAt: string | null;
  workerHeartbeatAt: string | null;
};

export function getInstanceState(): InstanceState {
  const r = getDb().prepare(`SELECT * FROM instance_state WHERE id = 1`).get() as Record<string, unknown> | undefined;
  if (!r) {
    return { restoredHold: false, deploymentEpoch: 0, restoredAt: null, restoredFrom: null, resumedAt: null, workerHeartbeatAt: null };
  }
  return {
    restoredHold: r.restored_hold === 1,
    deploymentEpoch: r.deployment_epoch as number,
    restoredAt: (r.restored_at as string | null) ?? null,
    restoredFrom: (r.restored_from as string | null) ?? null,
    resumedAt: (r.resumed_at as string | null) ?? null,
    workerHeartbeatAt: (r.worker_heartbeat_at as string | null) ?? null,
  };
}

export function isRestoredHold(): boolean {
  return getInstanceState().restoredHold;
}

export function touchWorkerHeartbeat(nowIso = new Date().toISOString()): void {
  getDb().prepare(`UPDATE instance_state SET worker_heartbeat_at = ? WHERE id = 1`).run(nowIso);
}

/** Web/worker 的外部动作入口共用：hold 期间返回说明，调用方不得发起请求 */
export const RESTORED_HOLD_MESSAGE =
  "实例刚从备份恢复，邮件、搜索和模型调用已暂停。核对数据并确认旧实例已停止后，运行 scripts/resume-after-restore.sh 再继续。";
