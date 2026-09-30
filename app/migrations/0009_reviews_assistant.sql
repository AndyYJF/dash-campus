-- T6 复盘与主动建议（计划 v1.2 第 4.2、6 节；产品计划第 12 节）
-- reviews / review_edits：同周期允许草案修订；原事实引用保留，主人编辑与 AI 草案分开
-- assistant_requests：限定 project 或 week 范围的助手请求（卡点辅助）
-- ai_usage：每次模型/搜索调用的模型、耗时、token、状态（不记录完整请求原文）

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'weekly' CHECK (kind IN ('weekly')),
  local_monday TEXT NOT NULL,
  timezone TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'generating', 'ready', 'insufficient', 'failed', 'cancelled')),
  job_id TEXT REFERENCES jobs(id),
  -- 程序汇总的事实快照（生成时冻结，原事实引用保留）
  facts_json TEXT,
  -- 模型观察（推测）与提案 id；模型未运行时为 NULL
  ai_draft_json TEXT,
  -- 模型未运行的原因：not_configured / budget / no_records / error
  ai_skipped_reason TEXT,
  integration_mode TEXT CHECK (integration_mode IS NULL OR integration_mode IN ('real', 'fixture', 'none')),
  error_code TEXT,
  error_message TEXT,
  -- 主人本人修订：与 AI 草案分开保存
  owner_summary TEXT NOT NULL DEFAULT '',
  owner_next_week TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  generated_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_reviews_week ON reviews(local_monday, timezone);

CREATE TABLE review_edits (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(id),
  field TEXT NOT NULL CHECK (field IN ('owner_summary', 'owner_next_week')),
  value TEXT NOT NULL,
  review_version INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_review_edits_review ON review_edits(review_id);

CREATE TABLE assistant_requests (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'week')),
  -- project：项目 id；week：该周周一（实例时区）
  scope_id TEXT NOT NULL,
  question TEXT NOT NULL,
  log_id TEXT REFERENCES daily_logs(id),
  -- 主人主动重跑：忽略拒绝冷却（第 6 节"用户可主动重跑"）
  rerun INTEGER NOT NULL DEFAULT 0 CHECK (rerun IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'insufficient', 'failed', 'cancelled')),
  job_id TEXT REFERENCES jobs(id),
  result_json TEXT,
  integration_mode TEXT CHECK (integration_mode IS NULL OR integration_mode IN ('real', 'fixture')),
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_assistant_log ON assistant_requests(log_id);

CREATE TABLE ai_usage (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('model', 'search')),
  workflow TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  -- 实例时区的日期，用于每日额度
  local_date TEXT NOT NULL,
  started_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'error')),
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  related_type TEXT,
  related_id TEXT
);
CREATE INDEX idx_ai_usage_date ON ai_usage(local_date, kind);

-- 提案来源、所属项目（冷却键：同项目同操作类型同证据）、版本与拒绝反馈
ALTER TABLE proposals ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual'
  CHECK (source_kind IN ('manual', 'assistant', 'review'));
ALTER TABLE proposals ADD COLUMN source_id TEXT;
ALTER TABLE proposals ADD COLUMN project_id TEXT;
ALTER TABLE proposals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE proposals ADD COLUMN rejection_reason TEXT
  CHECK (rejection_reason IS NULL OR rejection_reason IN ('not_useful', 'wrong_basis', 'no_time', 'other'));
CREATE INDEX idx_proposals_fingerprint ON proposals(evidence_fingerprint, status);
CREATE INDEX idx_proposals_source ON proposals(source_kind, source_id);

-- 周复盘需要"本周完成"：之前只能用 updated_at 近似
ALTER TABLE tasks ADD COLUMN completed_at TEXT;
UPDATE tasks SET completed_at = updated_at WHERE status = 'done';
