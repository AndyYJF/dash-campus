-- T3 持久任务与邮件：jobs / deliveries / settings（计划 v1.2 第 4.2、8 节）
-- jobs 必须有 lease_token、lease_until、attempt、generation、run_at、payload、dedupe_key（8.1）
-- 查询频繁的状态、时间、关联 ID 使用独立列（4.2）：task_id 为独立列，不放 JSON 里

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  task_id TEXT,
  dedupe_key TEXT NOT NULL UNIQUE,
  run_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  lease_token TEXT,
  lease_until TEXT,
  attempt INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_jobs_status_run_at ON jobs(status, run_at);
CREATE INDEX idx_jobs_task ON jobs(task_id);

-- delivery 有 request_id、lease_token、payload_snapshot 与状态（4.2）
CREATE TABLE deliveries (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id),
  task_id TEXT,
  request_id TEXT NOT NULL UNIQUE,
  lease_token TEXT,
  reminder_revision INTEGER NOT NULL DEFAULT 0,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'submitting', 'accepted', 'failed', 'unknown', 'cancelled')),
  attempt INTEGER NOT NULL DEFAULT 1,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_deliveries_status ON deliveries(status);
CREATE INDEX idx_deliveries_task ON deliveries(task_id);
CREATE INDEX idx_deliveries_job ON deliveries(job_id);

-- 非敏感设置保存在数据库（计划第 3 节）；键唯一（4.2）
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
