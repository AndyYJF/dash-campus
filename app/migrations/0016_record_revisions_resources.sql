-- Preserve owner corrections and the evidence previously cited by a review or proposal.
ALTER TABLE daily_logs ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1);
ALTER TABLE daily_logs ADD COLUMN archived_at TEXT;
CREATE TABLE daily_log_revisions (
  log_id TEXT NOT NULL REFERENCES daily_logs(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(log_id,version)
);
INSERT INTO daily_log_revisions(log_id,version,snapshot_json,created_at)
SELECT id,version,json_object('occurredOn',occurred_on,'progress',progress,'blocker',blocker,'taskId',task_id,'projectId',project_id,'archivedAt',archived_at),updated_at FROM daily_logs;
CREATE TABLE artifact_revisions (
  artifact_id TEXT NOT NULL REFERENCES artifacts(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(artifact_id,version)
);
INSERT INTO artifact_revisions(artifact_id,version,snapshot_json,created_at)
SELECT id,version,json_object('projectId',project_id,'logId',log_id,'kind',kind,'title',title,'body',body,'url',url,'archivedAt',archived_at),updated_at FROM artifacts;
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('text','url')),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  url TEXT,
  source_year INTEGER,
  source_kind TEXT NOT NULL DEFAULT 'user_supplied',
  version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1),
  archived_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE resource_revisions (
  resource_id TEXT NOT NULL REFERENCES resources(id),
  version INTEGER NOT NULL CHECK(version >= 1),
  snapshot_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(resource_id,version)
);
CREATE INDEX idx_resources_active ON resources(archived_at,updated_at);
CREATE TABLE evidence_resource_refs (
  evidence_id TEXT PRIMARY KEY REFERENCES evidence_documents(id),
  resource_id TEXT NOT NULL,
  resource_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  FOREIGN KEY(resource_id,resource_version) REFERENCES resource_revisions(resource_id,version)
);
