import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDb, closeDb } from "@/repositories/db";

// 每个测试文件独立进程、独立临时数据库。
// env 在模块顶层设置；配置与连接都是首次调用时才读取，因此安全。
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dash-campus-test-"));
process.env.DATABASE_PATH = path.join(tmpDir, "test.db");
process.env.SETUP_TOKEN = "test-setup-token";

/** 执行全部迁移（测试用，等价于 migrate 命令） */
export function migrateAll(): void {
  const db = getDb();
  const dir = path.resolve(process.cwd(), "migrations");
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const tx = db.transaction(() => {
    for (const f of files) {
      db.exec(fs.readFileSync(path.join(dir, f), "utf8"));
      const version = Number(f.slice(0, 4));
      db.prepare(
        `INSERT INTO schema_version (id, version, applied_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
      ).run(version, new Date().toISOString());
    }
  });
  tx();
}

export { getDb, closeDb };
