import { closeDb, schemaProblem } from "@/repositories/db";

/**
 * Web 进程启动检查（计划 10.1）：只检查 schemaVersion，不改表；不兼容即退出并说明。
 * 只在 Node.js 运行时由 instrumentation.ts 动态导入（Edge 编译不包含本文件）。
 */
const problem = schemaProblem();
if (problem) {
  console.error(`[web] ${problem}`);
  closeDb();
  process.exit(1);
}
