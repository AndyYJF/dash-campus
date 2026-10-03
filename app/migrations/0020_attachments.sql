-- P4：附件与 blob（MASTER-PLAN §3/§5.1）。blob 按 hash 去重；附件引用不复制文件。
-- intake_blobs 是二进制原件，不进 full_json 导出（列入排除表），恢复契约另行覆盖。

CREATE TABLE intake_blobs (
  hash TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  content BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE intake_attachments (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intakes(id),
  blob_hash TEXT NOT NULL REFERENCES intake_blobs(hash),
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  original_name TEXT NOT NULL DEFAULT '',
  extraction_state TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_state IN ('pending', 'done', 'failed', 'unsupported')),
  created_at TEXT NOT NULL,
  UNIQUE (intake_id, blob_hash)
);
CREATE INDEX idx_intake_attachments_intake ON intake_attachments(intake_id);
