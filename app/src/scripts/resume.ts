import readline from "node:readline/promises";
import { closeDb } from "@/repositories/db";
import { resumeAfterRestore, restoreStatus } from "@/workflows/restore";
import { OpsError } from "@/scripts/ops-lib";

/**
 * 恢复后启用（计划 10.2）：用法 `scripts/resume-after-restore.sh [--yes-old-instance-stopped]`
 * 需要显式确认旧实例已停止——新实例无法替你保证远端旧实例不再发邮件。
 * 取消恢复出来的历史 job，只按当前任务重建触发时间晚于现在的提醒；周期任务从下一周期开始。
 */

async function confirm(): Promise<boolean> {
  if (process.argv.includes("--yes-old-instance-stopped")) return true;
  if (!process.stdin.isTTY) {
    throw new OpsError("需要确认：交互终端里运行，或传 --yes-old-instance-stopped 表示你已确认旧实例停止");
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question("确认旧实例（包括其他机器上的）web/worker 都已停止？输入 yes 继续：");
  rl.close();
  return a.trim() === "yes";
}

async function main(): Promise<void> {
  const st = restoreStatus();
  if (!st.hold) {
    console.log("实例不在恢复暂停状态，无需操作。");
    return;
  }
  console.log(`恢复时间 ${st.restoredAt}，来源 ${st.restoredFrom}`);
  console.log(`  挂起的旧后台任务 ${st.heldJobs.length} 个；触发点已过的提醒 ${st.pastReminders.length} 条（不会补发）；结果不确定的投递 ${st.unknownDeliveries} 条`);
  if (!(await confirm())) throw new OpsError("未确认，保持暂停");
  const r = resumeAfterRestore();
  if (!r.ok) {
    console.log("实例不在恢复暂停状态，无需操作。");
    return;
  }
  console.log("已解除恢复暂停：");
  console.log(`  取消旧后台任务 ${r.cancelledJobs} 个、未准入投递 ${r.cancelledDeliveries} 条`);
  console.log(`  按当前任务重建未来提醒 ${r.rebuiltReminders} 条；过去的 ${r.skippedPastReminders} 条只在"今日待处理"显示`);
  console.log(`  定期探索 ${r.topicsRescheduled} 个从下一周期开始；定期周复盘从下一周期开始`);
  if (r.stoppedIntakes) console.log(`  恢复前没处理完的 ${r.stoppedIntakes} 份投递已停止（原件保留，需要的话重新发一次）`);
  console.log("现在可以启动 worker（scripts/start.sh 或 docker compose up -d worker）。");
}

main()
  .catch((e) => {
    console.error(e instanceof OpsError ? `未完成：${e.message}` : e);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
