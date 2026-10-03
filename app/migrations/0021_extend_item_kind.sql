-- P4 修正：intake_items.kind 增加 'ics'（0017 的 CHECK 只允许 5 种；SQLite 需重建表改 CHECK）

PRAGMA foreign_keys = OFF;

CREATE TABLE intake_items_new (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intakes(id),
  stable_item_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('timetable', 'notice', 'practice', 'task', 'note', 'ics')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'extracted'
    CHECK (state IN ('extracted','resolving','awaiting_input','ready','applied','ignored','failed','cancelled')),
  evidence_json TEXT,
  waiting_question_id TEXT REFERENCES clarification_questions(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (intake_id, stable_item_key)
);

INSERT INTO intake_items_new
  SELECT id, intake_id, stable_item_key, kind, payload_json, state, evidence_json, waiting_question_id, version, created_at, updated_at
  FROM intake_items;

DROP TABLE intake_items;
ALTER TABLE intake_items_new RENAME TO intake_items;
CREATE INDEX intake_items_intake ON intake_items(intake_id);

PRAGMA foreign_keys = ON;
