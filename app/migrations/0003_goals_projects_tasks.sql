-- T1 目标 / 项目 / 任务基础（计划 v1.2 第 4.1、4.2 节）

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  horizon TEXT NOT NULL CHECK (horizon IN ('long_term', 'semester')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '',
  expected_outcome TEXT NOT NULL DEFAULT '',
  prerequisites TEXT NOT NULL DEFAULT '',
  review_questions TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE project_goals (
  project_id TEXT NOT NULL REFERENCES projects(id),
  goal_id TEXT NOT NULL REFERENCES goals(id),
  PRIMARY KEY (project_id, goal_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_id TEXT REFERENCES projects(id),
  goal_id TEXT REFERENCES goals(id),
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'high')),
  estimate_minutes INTEGER,
  planned_week_monday TEXT,
  planned_week_timezone TEXT,
  scheduled_start TEXT,
  scheduled_end TEXT,
  due_kind TEXT NOT NULL DEFAULT 'none' CHECK (due_kind IN ('none', 'date', 'instant')),
  due_local_date TEXT,
  due_timezone TEXT,
  due_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  reminder_revision INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_planned_week ON tasks(planned_week_monday);
CREATE INDEX idx_tasks_due_at ON tasks(due_at);
