-- P6/A03：课程单日例外（停课/调课）。例外是独立事实，撤销即移除，不改课程本体。

CREATE TABLE course_event_exceptions (
  id TEXT PRIMARY KEY,
  course_set_id TEXT NOT NULL REFERENCES course_sets(id),
  course_name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'cancel' CHECK (action IN ('cancel')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (course_set_id, event_date)
);
CREATE INDEX idx_course_exceptions_date ON course_event_exceptions(event_date);
