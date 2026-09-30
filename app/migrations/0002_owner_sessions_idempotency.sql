-- T1 身份与幂等（计划 v1.2 第 4.2 节）

CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  setup_completed_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES owner(id),
  -- 只存 token 的 SHA-256 摘要，明文 token 不落库
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX idx_sessions_owner ON sessions(owner_id);

CREATE TABLE idempotency_keys (
  id TEXT PRIMARY KEY,
  actor_scope TEXT NOT NULL,
  route TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  response_body TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (actor_scope, route, key)
);
