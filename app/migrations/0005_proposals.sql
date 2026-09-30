-- T2 提案（计划 v1.2 第 6 节）：group 只是展示集合；每份 proposal 原子应用

CREATE TABLE proposal_groups (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES proposal_groups(id),
  -- contextRefs 只能是真实记录或证据 ID 的 JSON 数组
  context_refs TEXT NOT NULL DEFAULT '[]',
  -- 生成时读集实体的版本快照
  input_versions_json TEXT NOT NULL DEFAULT '{}',
  -- 生成时的计划修订计数；排程类提案 apply 时校验
  planning_revision INTEGER NOT NULL,
  operations TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  reason_code TEXT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'applied', 'rejected', 'snoozed')),
  snooze_until TEXT,
  evidence_fingerprint TEXT,
  result_refs_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX idx_proposals_status ON proposals(status);

CREATE TABLE proposal_operations (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES proposals(id),
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create_task', 'reschedule_task', 'set_task_status')),
  payload TEXT NOT NULL,
  result_task_id TEXT,
  UNIQUE (proposal_id, seq)
);
