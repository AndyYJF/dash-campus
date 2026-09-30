import fs from "node:fs";
import path from "node:path";
import { getConfig } from "@/config";
import {
  assertStopped,
  BACKUP_DB_FILE,
  BACKUP_MANIFEST,
  OpsError,
  readSchemaVersion,
  sha256File,
  snapshotDatabase,
  timestamp,
  type BackupManifest,
} from "@/scripts/ops-lib";
import pkg from "../../package.json";

/**
 * 停机备份（计划 10.2）：用法 `scripts/backup.sh <备份根目录>`
 * 前提：web/worker 已停止（脚本会检查 worker 心跳与 health 端点，仍在运行则拒绝）。
 * 产物：<根目录>/dash-campus-backup-<时间>/{dash-campus.db, manifest.json}，目录权限 700。
 * 导出缓存无需备份（V1 无附件）。
 */

async function main(): Promise<void> {
  const root = process.argv[2];
  if (!root) throw new OpsError("用法：scripts/backup.sh <备份根目录>");
  const cfg = getConfig();
  const dbPath = path.resolve(cfg.DATABASE_PATH);
  if (!fs.existsSync(dbPath)) throw new OpsError(`数据库不存在：${dbPath}`);
  await assertStopped(dbPath, cfg.APP_BASE_URL);

  const outDir = path.join(path.resolve(root), `dash-campus-backup-${timestamp()}`);
  if (fs.existsSync(outDir)) throw new OpsError(`目标已存在：${outDir}`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

  const dest = path.join(outDir, BACKUP_DB_FILE);
  await snapshotDatabase(dbPath, dest);
  fs.chmodSync(dest, 0o600);
  const manifest: BackupManifest = {
    format: "dash-campus.backup",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    appVersion: pkg.version,
    schemaVersion: readSchemaVersion(dest),
    file: BACKUP_DB_FILE,
    sha256: sha256File(dest),
    sizeBytes: fs.statSync(dest).size,
  };
  fs.writeFileSync(path.join(outDir, BACKUP_MANIFEST), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  console.log(`备份完成：${outDir}`);
  console.log(`  schemaVersion ${manifest.schemaVersion}，应用版本 ${manifest.appVersion}，${manifest.sizeBytes} 字节`);
  console.log(`  sha256 ${manifest.sha256}`);
  console.log("备份包含个人数据，请放在只有你能读的位置。现在可以按原状态启动（scripts/start.sh）。");
}

main().catch((e) => {
  console.error(e instanceof OpsError ? `备份失败：${e.message}` : e);
  process.exit(1);
});
