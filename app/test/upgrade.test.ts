import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { getDb } from "./helpers";
import { runMigrations } from "@/scripts/migrate-lib";
import { getSchemaVersion, EXPECTED_SCHEMA_VERSION } from "@/repositories/db";

test("真实迁移器将 schema 11 升级到当前版：旧任务 / 规则 / 主人修改过的模板保持不变", () => {
  const db = getDb(), dir = path.resolve("migrations");
  for (const file of fs.readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f) && Number(f.slice(0, 4)) <= 11).sort()) {
    db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
    db.prepare("INSERT INTO schema_version(id,version,applied_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,applied_at=excluded.applied_at").run(Number(file.slice(0, 4)), new Date().toISOString());
  }
  db.prepare("INSERT INTO tasks(id,title,description,created_at,updated_at) VALUES('legacy-task','原任务','旧说明',?,?)").run(new Date().toISOString(), new Date().toISOString());
  db.prepare("UPDATE practice_templates SET version=3,question='主人已改写的检索问题' WHERE id='tpl-text-retrieval'").run();
  const at=new Date().toISOString();
  db.prepare("INSERT INTO projects(id,title,question,expected_outcome,prerequisites,review_questions,created_at,updated_at) VALUES('legacy-project','项目','','','','',?,?)").run(at,at);
  db.prepare("INSERT INTO daily_logs(id,client_entry_id,occurred_on,progress,blocker,created_at,updated_at) VALUES('legacy-log','legacy-entry','2026-10-03','旧日志','旧卡点',?,?)").run(at,at);
  db.prepare("INSERT INTO artifacts(id,project_id,kind,title,body,version,created_at,updated_at,archived_at) VALUES('legacy-artifact','legacy-project','text','当前成果','当前正文',3,?,?,?)").run(at,at,at);
  const migration = runMigrations(db);
  assert.equal(migration.kind, "migrated"); assert.equal(getSchemaVersion(db), EXPECTED_SCHEMA_VERSION);
  const task = db.prepare("SELECT title,description,reminder_lead_minutes,planning_override_reason FROM tasks WHERE id='legacy-task'").get();
  assert.deepEqual(task, { title: "原任务", description: "旧说明", reminder_lead_minutes: null, planning_override_reason: null });
  const template = db.prepare("SELECT question,version,status FROM practice_templates WHERE id='tpl-text-retrieval'").get();
  assert.deepEqual(template, { question: "主人已改写的检索问题", version: 3, status: "draft" });
  const logRevision=db.prepare("SELECT version,snapshot_json FROM daily_log_revisions WHERE log_id='legacy-log'").get() as {version:number;snapshot_json:string};
  assert.equal(logRevision.version,1);assert.equal(JSON.parse(logRevision.snapshot_json).progress,"旧日志");
  const artifactRevision=db.prepare("SELECT version,snapshot_json FROM artifact_revisions WHERE artifact_id='legacy-artifact'").get() as {version:number;snapshot_json:string};
  assert.equal(artifactRevision.version,3);assert.equal(JSON.parse(artifactRevision.snapshot_json).archivedAt,at);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM artifact_revisions WHERE artifact_id='legacy-artifact'").get() as {n:number}).n,1,"不伪造迁移前版本");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  assert.equal(runMigrations(db).kind, "up_to_date");
});
