-- P2：课程语义模型 + 命令 journal + 来源关联（MASTER-PLAN §5.1/§5.3）
-- 投影只指向 fixed_events；撤销粒度 = agent_action_batches。

CREATE TABLE semesters (
  id TEXT PRIMARY KEY,
  first_monday TEXT NOT NULL,
  total_weeks INTEGER NOT NULL CHECK (total_weeks BETWEEN 1 AND 60),
  timezone TEXT NOT NULL,
  fact_origin TEXT NOT NULL DEFAULT 'user_confirmed' CHECK (fact_origin IN ('user_confirmed', 'assumed', 'source')),
  source TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (first_monday, total_weeks, timezone)
);

CREATE TABLE course_sets (
  id TEXT PRIMARY KEY,
  semester_id TEXT NOT NULL REFERENCES semesters(id),
  source TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_course_sets_semester ON course_sets(semester_id, status);

CREATE TABLE courses (
  id TEXT PRIMARY KEY,
  course_set_id TEXT NOT NULL REFERENCES course_sets(id),
  name TEXT NOT NULL,
  teacher TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_courses_set ON courses(course_set_id);

CREATE TABLE course_meetings (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  local_start TEXT NOT NULL,
  local_end TEXT NOT NULL,
  weeks_json TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_course_meetings_course ON course_meetings(course_id);

CREATE TABLE course_meeting_projections (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES course_meetings(id),
  fixed_event_id TEXT NOT NULL REFERENCES fixed_events(id),
  source_version INTEGER NOT NULL,
  rule_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (meeting_id, rule_hash)
);

CREATE TABLE entity_source_links (
  id TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  source_namespace TEXT NOT NULL,
  external_id TEXT NOT NULL DEFAULT '',
  revision TEXT NOT NULL DEFAULT '',
  item_key TEXT NOT NULL DEFAULT '',
  field_path TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (entity_kind, entity_id, source_namespace, external_id, revision, item_key)
);
CREATE INDEX idx_entity_source_links_entity ON entity_source_links(entity_kind, entity_id);

CREATE TABLE agent_action_batches (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  intake_id TEXT,
  item_id TEXT,
  policy_version TEXT NOT NULL DEFAULT 'v2-p2',
  instance_epoch INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone')),
  created_at TEXT NOT NULL,
  undone_at TEXT
);
CREATE INDEX idx_action_batches_intake ON agent_action_batches(intake_id);

CREATE TABLE agent_action_changes (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES agent_action_batches(id),
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  before_json TEXT,
  after_json TEXT,
  before_version INTEGER,
  after_version INTEGER
);
CREATE INDEX idx_action_changes_batch ON agent_action_changes(batch_id);

CREATE TABLE practice_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  project_id TEXT REFERENCES projects(id),
  occurred_on TEXT NOT NULL,
  actual_minutes INTEGER,
  minutes_origin TEXT NOT NULL DEFAULT 'user_reported' CHECK (minutes_origin IN ('timer', 'user_reported')),
  blocker TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  artifact_refs TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_practice_entries_day ON practice_entries(occurred_on);
