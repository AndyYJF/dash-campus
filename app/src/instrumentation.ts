/**
 * 服务启动钩子（Next 在每个服务实例启动时调用一次 register）。
 * 迁移只由独立 migrate 命令执行；这里只在 Node.js 运行时检查 schema 版本。
 */
export async function register() {
  // 构建阶段不连接数据库
  if (process.env.NEXT_PHASE === "phase-production-build") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
