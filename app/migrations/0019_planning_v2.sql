-- P3：规划偏好（模板起始，tentative 待确认）+ plan_sessions（多次学习排程的唯一来源，MASTER-PLAN §5.2）

CREATE TABLE planning_preferences (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  workday_start TEXT NOT NULL DEFAULT '08:00',
  workday_end TEXT NOT NULL DEFAULT '22:00',
  weekend_start TEXT NOT NULL DEFAULT '09:00',
  weekend_end TEXT NOT NULL DEFAULT '22:00',
  meals_json TEXT NOT NULL DEFAULT '[["07:30","08:30"],["12:00","13:00"],["18:00","19:00"]]',
  commute_minutes INTEGER NOT NULL DEFAULT 15,
  daily_limit_minutes INTEGER NOT NULL DEFAULT 180,
  min_block_minutes INTEGER NOT NULL DEFAULT 25,
  buffer_percent INTEGER NOT NULL DEFAULT 20,
  status TEXT NOT NULL DEFAULT 'tentative' CHECK (status IN ('tentative', 'confirmed')),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
INSERT INTO planning_preferences (id, updated_at) VALUES (1, datetime('now'));

CREATE TABLE plan_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('tentative', 'planned', 'in_progress', 'completed', 'skipped', 'superseded')),
  locked INTEGER NOT NULL DEFAULT 0,
  batch_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_plan_sessions_task ON plan_sessions(task_id);
CREATE INDEX idx_plan_sessions_start ON plan_sessions(start_utc);
