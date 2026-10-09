import { closeDb, schemaProblem } from "@/repositories/db";
import { demoStartupProblem } from "@/workflows/demo";

/**
 * Web 进程启动检查（计划 10.1）：只检查 schemaVersion，不改表；不兼容即退出并说明。
 * 只在 Node.js 运行时由 instrumentation.ts 动态导入（Edge 编译不包含本文件）。
 */
// 展示模式与数据库必须对得上（演示模式绝不连正式库），同样只检查不改表
const problem = schemaProblem() ?? demoStartupProblem();
if (problem) {
  console.error(`[web] ${problem}`);
  closeDb();
  process.exit(1);
}
