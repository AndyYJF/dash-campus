import { closeDb, schemaProblem } from "@/repositories/db";
import { recoverOnStartup, runDueJobsOnce } from "@/worker/runner";
import { demoStartupProblem, ensureDemoModelCapabilities, maintainDemo } from "@/workflows/demo";

/**
 * worker 进程入口：`npm run worker`。
 * 数据库持久 job，不依赖浏览器定时器；轮询间隔 5 秒。
 * 一个实例一个 worker：启动先恢复孤儿任务，再进入轮询循环。
 */

const POLL_INTERVAL_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  // 只检查不改表：版本不兼容即退出并说明（计划 10.1）
  const problem = schemaProblem() ?? demoStartupProblem();
  if (problem) {
    console.error(`[worker] ${problem}`);
    closeDb();
    process.exit(1);
  }
  console.log(`[worker] 启动，轮询间隔 ${POLL_INTERVAL_MS}ms`);
  const recovered = recoverOnStartup();
  console.log(
    `[worker] 恢复完成：${recovered.unknownDeliveries} 个投递标记 unknown，${recovered.requeuedJobs} 个孤儿 job 重新排队`,
  );

  // 演示实例：访客不能手动探测模型端点，没有有效结论时启动先探测一次
  const probe = await ensureDemoModelCapabilities();
  if (probe !== "skipped") console.log(`[worker] 演示实例模型端点探测：${probe === "probed" ? "已完成" : "失败，按兼容方式调用"}`);

  let stopped = false;
  let heldLogged = false;
  const shutdown = () => {
    if (!stopped) console.log("[worker] 收到停止信号，等待在途任务结束后退出");
    stopped = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (!stopped) {
    try {
      // 演示实例：到每日恢复时间就把数据恢复成初始示例（两趟任务之间执行，不打断在途任务）
      if (maintainDemo()) console.log("[worker] 演示数据已恢复成初始示例");
      const stats = await runDueJobsOnce();
      if (stats.held && !heldLogged) {
        console.log("[worker] 实例处于恢复暂停（restored_hold）：不领取任务、不发起外部请求。确认后运行 scripts/resume-after-restore.sh");
      }
      heldLogged = Boolean(stats.held);
      if (stats.claimed > 0) {
        console.log(`[worker] 本趟领取 ${stats.claimed}，完成 ${stats.done}，失败 ${stats.failed}，取消 ${stats.cancelled}`);
      }
    } catch (e) {
      console.error("[worker] 执行出错（继续轮询）:", e);
    }
    await sleep(POLL_INTERVAL_MS);
  }

  closeDb();
  console.log("[worker] 已退出");
}

main().catch((e) => {
  console.error("[worker] 致命错误:", e);
  process.exit(1);
});
