-- T4 收件箱（计划 v1.2 第 4.2、5 节）：身份事实 / 人工规则 / 导入来源 / 逻辑消息与修订 / 决策 / 任务关联

-- 明确字段和值及来源；主人确认事实，一个字段一个当前值
CREATE TABLE profile_facts (
  id TEXT PRIMARY KEY,
  field TEXT NOT NULL UNIQUE,
  value TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'master',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 人工规则：明确 source、通知类型、结构化条件和输出；必须主人启用；保存 scope 和 version
CREATE TABLE profile_rules (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  notice_type TEXT NOT NULL,
  condition_json TEXT NOT NULL,
  output_partition TEXT NOT NULL CHECK (output_partition IN ('action', 'info', 'opportunity', 'review', 'folded')),
  priority INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 导入来源：持久来源标识 + 导入 token 摘要（token 明文只在创建时显示一次）
CREATE TABLE inbox_sources (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  token_digest TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- (source, external_id) 唯一逻辑消息；current_revision_id 指向当前版本
CREATE TABLE inbox_messages (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES inbox_sources(id),
  external_id TEXT NOT NULL,
  current_revision_id TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revision_conflict')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (source_id, external_id)
);

-- (message_id, revision_key) 唯一版本；不可变（原文版本不可变）
CREATE TABLE inbox_revisions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES inbox_messages(id),
  revision_key TEXT NOT NULL,
  revision_order INTEGER,
  occurred_at TEXT NOT NULL,
  text TEXT NOT NULL,
  source_url TEXT,
  structured_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (message_id, revision_key)
);
CREATE INDEX idx_inbox_revisions_message ON inbox_revisions(message_id);

-- 决策关联具体 revision、规则版本；applicability 与分区分开保存
CREATE TABLE inbox_decisions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES inbox_messages(id),
  revision_id TEXT NOT NULL UNIQUE REFERENCES inbox_revisions(id),
  applicability TEXT CHECK (applicability IN ('TRUE', 'FALSE', 'UNKNOWN')),
  base_partition TEXT NOT NULL CHECK (base_partition IN ('action', 'info', 'opportunity', 'review', 'folded')),
  matched_rule_id TEXT,
  matched_rule_version INTEGER,
  manual_partition TEXT CHECK (manual_partition IN ('action', 'info', 'opportunity', 'review', 'folded')),
  partition TEXT NOT NULL CHECK (partition IN ('action', 'info', 'opportunity', 'review', 'folded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_inbox_decisions_message ON inbox_decisions(message_id);

-- (message_id, action_key) 唯一自动任务关联；来源更新永不自动覆盖已建任务
CREATE TABLE inbox_task_links (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES inbox_messages(id),
  action_key TEXT NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision_id TEXT NOT NULL REFERENCES inbox_revisions(id),
  created_at TEXT NOT NULL,
  UNIQUE (message_id, action_key)
);

-- 人工编辑路径可记录来源版本（计划 5.1）
ALTER TABLE tasks ADD COLUMN source_revision_id TEXT;
