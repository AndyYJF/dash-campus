import { getConfig } from "@/config";
import { closeDb, getDb } from "@/repositories/db";
import { runMigrations } from "@/scripts/migrate-lib";
import { resetDemoData } from "@/workflows/demo";

/**
 * 建立或恢复演示库：`npm run demo:seed`（scripts/demo-seed.sh）。
 * 只在 DEMO_MODE=1 时执行，并且只肯写全新的库或已带演示标记的库——用正式实例的 .env 误跑会直接退出，不改任何数据。
 * 全新的库会先跑迁移；已有的演示库版本落后时也在这里迁移（演示数据可随时重建，不需要备份）。
 */
function main(): void {
  const cfg = getConfig();
  if (!cfg.DEMO_MODE) {
    console.error("没有设置 DEMO_MODE=1：这条命令只用于演示实例，已退出，未做任何修改。");
    process.exit(1);
  }
  const db = getDb();
  const hasOwnerTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='owner'`).get();
  const hasSettings = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='settings'`).get();
  const owner = hasOwnerTable ? db.prepare(`SELECT id FROM owner WHERE id = 1`).get() : undefined;
  const marker = hasSettings ? db.prepare(`SELECT key FROM settings WHERE key = 'demoInstance'`).get() : undefined;
  if (owner && !marker) {
    console.error(`拒绝执行：${cfg.DATABASE_PATH} 已有主人且没有演示标记，看起来是正式库。演示实例请使用单独的数据目录。`);
    closeDb();
    process.exit(1);
  }
  const migrated = runMigrations(db);
  if (migrated.kind === "too_new") {
    console.error(`数据库版本 ${migrated.version} 高于应用支持的 ${migrated.supported}，请升级应用或删除演示库后重建`);
    closeDb();
    process.exit(1);
  }
  const r = resetDemoData();
  closeDb();
  console.log(`演示数据已写入 ${cfg.DATABASE_PATH}（示例版本 ${r.seedVersion}，${r.seededAt}）`);
}

main();
