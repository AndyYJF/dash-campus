ALTER TABLE inbox_sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1));
ALTER TABLE inbox_sources ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
CREATE TABLE notice_extractions (
 revision_id TEXT PRIMARY KEY REFERENCES inbox_revisions(id) ON DELETE CASCADE,
 job_id TEXT REFERENCES jobs(id),
 integration_mode TEXT NOT NULL DEFAULT 'none',
 status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','superseded')),
 error TEXT,
 evidence_json TEXT,
 updated_at TEXT NOT NULL
);
