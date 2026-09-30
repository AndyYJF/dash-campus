import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/config";
import { closeDb, EXPECTED_SCHEMA_VERSION, getDb } from "@/repositories/db";
import { runMigrations } from "@/scripts/migrate-lib";
import { applyRestoreHold } from "@/workflows/restore";
import { assertStopped, OpsError, readManifest, sha256File, timestamp } from "@/scripts/ops-lib";

/**
 * 从备份恢复（计划 10.2 / F14）：用法 `scripts/restore.sh <备份目录>`
 * 1. 检查 web/worker 已停止；校验清单 hash 与 schema 版本
 * 2. 当前数据库文件组改名保留（不删除）为 *.pre-restore-<时间>
 * 3. 复制备份库到 DATABASE_PATH；版本较旧则执行迁移
 * 4. 在任何进程启动前写入 restored_hold、deploymentEpoch+1，旧 job 挂起、submitting 标 unknown
 * 之后只启动 web 核对数据；确认旧实例已停止后运行 scripts/resume-after-restore.sh
 */

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new OpsError("用法：scripts/restore.sh <备份目录>");
  const backupDir = path.resolve(dir);
  const manifest = readManifest(backupDir);
  const src = path.join(backupDir, manifest.file);
  if (!fs.existsSync(src)) throw new OpsError(`备份数据库文件不存在：${src}`);
  if (sha256File(src) !== manifest.sha256) throw new OpsError("备份文件 hash 与清单不符，可能已损坏，未做任何修改");
  if (manifest.schemaVersion !== null && manifest.schemaVersion > EXPECTED_SCHEMA_VERSION) {
    throw new OpsError(`备份 schema 版本 ${manifest.schemaVersion} 高于本应用支持的 ${EXPECTED_SCHEMA_VERSION}，请先升级应用`);
  }

  const cfg = getConfig();
  const dbPath = path.resolve(cfg.DATABASE_PATH);
  await assertStopped(dbPath, cfg.APP_BASE_URL);

  // 当前文件组改名保留：主文件与 -wal / -shm 一起，避免新库误读旧 WAL
  const suffix = `.pre-restore-${timestamp()}`;
  const kept: string[] = [];
  for (const ext of ["", "-wal", "-shm"]) {
    const p = `${dbPath}${ext}`;
    if (fs.existsSync(p)) {
      fs.renameSync(p, `${dbPath}${suffix}${ext}`);
      kept.push(`${dbPath}${suffix}${ext}`);
    }
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(src, dbPath, fs.constants.COPYFILE_EXCL);

  const db = getDb();
  const m = runMigrations(db);
  if (m.kind === "too_new") throw new OpsError("备份版本高于应用支持版本");
  const hold = applyRestoreHold(db, `${backupDir} (${manifest.createdAt})`);
  closeDb();

  console.log(`已从备份恢复：${backupDir}`);
  console.log(`  备份时间 ${manifest.createdAt}，schemaVersion ${manifest.schemaVersion}${m.kind === "migrated" ? ` → 已迁移到 ${m.to}` : ""}`);
  if (kept.length) console.log(`  原数据库已改名保留：${kept[0]}`);
  console.log(`  已进入恢复暂停（deploymentEpoch ${hold.deploymentEpoch}）：${hold.heldJobs} 个旧后台任务挂起，${hold.unknownDeliveries} 条投递结果不确定`);
  console.log("下一步：");
  console.log("  1. 只启动 web（scripts/start.sh web 或 docker compose up -d web），登录核对任务与恢复时间；");
  console.log("  2. 确认旧实例（包括其他机器上的）worker 已停止；");
  console.log("  3. 运行 scripts/resume-after-restore.sh，只重建未来提醒，不补发过去的邮件。");
}

main().catch((e) => {
  closeDb();
  console.error(e instanceof OpsError ? `恢复失败：${e.message}` : e);
  process.exit(1);
});
