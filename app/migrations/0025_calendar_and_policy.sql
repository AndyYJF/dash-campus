-- R0/R1：校历、国家节假日、教学日映射与时间政策（ACADEMIC-CALENDAR-AND-HOLIDAYS §3/§6，REPAIR-PLAN §4.1）。
-- 三层事实分开保存：国家日历只给公历日标签；学校教学日历决定教学周/停课/补课映射；课程/个人例外只影响指定课程或个人窗口。
-- 假日不存成 24h 固定活动；课程规则本体不变，映射只产生有效实例。

CREATE TABLE academic_calendars (
  id TEXT PRIMARY KEY,
  school TEXT NOT NULL DEFAULT '',
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'undergraduate', 'graduate')),
  academic_year TEXT NOT NULL DEFAULT '',
  term_label TEXT NOT NULL DEFAULT '',
  semester_id TEXT REFERENCES semesters(id),
  registration_date TEXT,                 -- 报到日（不等于开始授课，也不等于首周周一）
  teaching_start TEXT,                    -- 开始授课日
  first_monday TEXT,                      -- 第一教学周的周一
  total_weeks INTEGER,
  term_end TEXT,
  skipped_weeks_json TEXT NOT NULL DEFAULT '[]',  -- 学校明确不计入教学周编号的周（周一日期）；缺省线性编号
  source TEXT NOT NULL DEFAULT '',
  source_revision TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT 'source' CHECK (origin IN ('source', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_academic_calendars_semester ON academic_calendars(semester_id, status);

CREATE TABLE academic_calendar_events (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES academic_calendars(id),
  kind TEXT NOT NULL CHECK (kind IN ('holiday', 'exam', 'registration', 'teaching_start', 'term_end', 'training', 'other')),
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,                 -- 含首尾
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'undergraduate', 'graduate')),
  cancels_classes INTEGER NOT NULL DEFAULT 0,  -- 学校明确该区间停课
  evidence TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_academic_calendar_events_range ON academic_calendar_events(start_date, end_date);

CREATE TABLE holiday_datasets (
  id TEXT PRIMARY KEY,
  region TEXT NOT NULL DEFAULT 'CN',
  year INTEGER NOT NULL,
  source_url TEXT NOT NULL DEFAULT '',
  source_title TEXT NOT NULL DEFAULT '',
  revision_hash TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('official', 'user_upload', 'third_party')),
  published_at TEXT,
  checked_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'superseded', 'undone')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (region, year, revision_hash)
);

CREATE TABLE holiday_days (
  id TEXT PRIMARY KEY,
  dataset_id TEXT NOT NULL REFERENCES holiday_datasets(id),
  local_date TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('holiday', 'adjusted_workday')),
  UNIQUE (dataset_id, local_date)
);
CREATE INDEX idx_holiday_days_date ON holiday_days(local_date);

-- 教学日例外：学校范围（停课 / 目标日按源教学日上课）与课程范围（单次取消 / 移动）。
-- 周次、单双周等条件一律按 source_teaching_date 判断，不按目标日期重新筛选。
CREATE TABLE teaching_day_overrides (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('school', 'course')),
  course_id TEXT REFERENCES courses(id),
  mode TEXT NOT NULL CHECK (mode IN ('cancel', 'replace', 'add', 'move')),
  source_teaching_date TEXT NOT NULL,
  target_date TEXT,
  target_start TEXT,
  target_end TEXT,
  calendar_id TEXT REFERENCES academic_calendars(id),
  origin TEXT NOT NULL DEFAULT 'source' CHECK (origin IN ('source', 'user')),
  source TEXT NOT NULL DEFAULT '',
  evidence TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'undone')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_teaching_overrides_source ON teaching_day_overrides(source_teaching_date, status);
CREATE INDEX idx_teaching_overrides_target ON teaching_day_overrides(target_date, status);

-- 有限来源刷新的状态：未获取/失败/未发布 与 已核对无变化 明确区分
CREATE TABLE calendar_sync_sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('holiday', 'academic')),
  scope_key TEXT NOT NULL,                -- 年度（如 2026）或 学校|学年
  url TEXT NOT NULL DEFAULT '',
  last_checked_at TEXT,
  last_hash TEXT,
  last_status TEXT NOT NULL DEFAULT 'never' CHECK (last_status IN ('never', 'ok', 'unchanged', 'not_published', 'failed', 'no_source', 'needs_review')),
  last_error TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, scope_key)
);

-- 撤销过的来源版本：同 revision 不被下一次同步重新套用
CREATE TABLE source_tombstones (
  id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  external_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (namespace, external_id, revision)
);

-- 时间政策规则：持久规则与临时覆盖分开；授权有范围、可撤回（REPAIR-PLAN §4.1.1）
CREATE TABLE planning_policy_rules (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('weekday_limit', 'group_limit', 'no_study', 'holiday_policy', 'preferred_window', 'auto_reschedule')),
  weekday INTEGER CHECK (weekday IS NULL OR weekday BETWEEN 1 AND 7),
  date_from TEXT,
  date_to TEXT,
  value_json TEXT NOT NULL DEFAULT '{}',
  scope TEXT NOT NULL CHECK (scope IN ('persistent', 'temporary')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  origin TEXT NOT NULL DEFAULT 'user' CHECK (origin IN ('user', 'assumed')),
  evidence TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_planning_policy_rules_kind ON planning_policy_rules(kind, status);
