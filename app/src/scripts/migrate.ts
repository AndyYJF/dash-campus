import { getDb, closeDb } from "@/repositories/db";
import { runMigrations } from "@/scripts/migrate-lib";

/**
 * 独立迁移命令：`npm run migrate`（scripts/migrate.sh）。
 * 顺序：停止 web/worker → 备份 → migrate → 启动（计划 10.1）；服务进程只检查版本，不改表。
 */

function main(): void {
  const r = runMigrations(getDb());
  closeDb();
  if (r.kind === "too_new") {
    console.error(`数据库版本 ${r.version} 高于应用支持的 ${r.supported}，请升级应用`);
    process.exit(1);
  }
  if (r.kind === "up_to_date") {
    console.log(`已是最新 schema 版本 ${r.version}`);
    return;
  }
  for (const f of r.applied) console.log(`已应用迁移 ${f}`);
  console.log(`迁移完成，当前版本 ${r.to}`);
}

main();
