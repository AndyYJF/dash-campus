-- T2 执行闭环：日志 / 成果 / 周重点 / 可用窗口 / 固定事件 / 计划修订计数

CREATE TABLE daily_logs (
  id TEXT PRIMARY KEY,
  -- 客户端草稿 ID：实例内唯一；同 ID 不同正文为 409
  client_entry_id TEXT NOT NULL UNIQUE,
  occurred_on TEXT NOT NULL,
  progress TEXT NOT NULL DEFAULT '',
  blocker TEXT NOT NULL DEFAULT '',
  task_id TEXT REFERENCES tasks(id),
  project_id TEXT REFERENCES projects(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (progress <> '' OR blocker <> '')
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  log_id TEXT REFERENCES daily_logs(id),
  kind TEXT NOT NULL CHECK (kind IN ('text', 'link')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_artifacts_project ON artifacts(project_id);

-- 每周最多一项重点；goal/project 至多关联一个；可仅文本
CREATE TABLE weekly_focus (
  id TEXT PRIMARY KEY,
  local_monday TEXT NOT NULL,
  timezone TEXT NOT NULL,
  title TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  project_id TEXT REFERENCES projects(id),
  confirmed_at TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (goal_id IS NULL OR project_id IS NULL),
  UNIQUE (local_monday, timezone)
);

CREATE TABLE availability_blocks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_start TEXT NOT NULL,
  local_end TEXT NOT NULL,
  timezone TEXT NOT NULL,
  valid_from TEXT,
  valid_until TEXT
);

CREATE TABLE fixed_events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_start TEXT NOT NULL,
  local_end TEXT NOT NULL,
  timezone TEXT NOT NULL,
  event_date TEXT,
  valid_from TEXT,
  valid_until TEXT
);

-- 计划修订计数：课程/可用时间/任务计划时间变化时递增（单行，id=1）
CREATE TABLE planning_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  planning_revision INTEGER NOT NULL DEFAULT 0
);
INSERT INTO planning_state (id, planning_revision) VALUES (1, 0);
