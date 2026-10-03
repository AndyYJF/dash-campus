-- 来源与主人业务字段分离。仅初次导入创建；重导不覆盖任务。
-- 桥接资格提取只读上游原文节选，不读旧插件生成的标题、摘要和行动。
ALTER TABLE inbox_revisions ADD COLUMN extraction_text TEXT;
ALTER TABLE inbox_revisions ADD COLUMN extraction_occurred_at TEXT;
CREATE TABLE legacy_instances (
  source_id TEXT PRIMARY KEY,
  timezone TEXT NOT NULL,
  campus_source_id TEXT UNIQUE REFERENCES inbox_sources(id),
  created_at TEXT NOT NULL
);
CREATE TABLE legacy_mappings (
  source_id TEXT NOT NULL REFERENCES legacy_instances(source_id),
  kind TEXT NOT NULL CHECK(kind IN ('project','task')),
  external_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  source_json TEXT NOT NULL,
  upstream_external_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY(source_id,kind,external_id)
);
CREATE INDEX idx_legacy_upstream ON legacy_mappings(source_id,upstream_external_id);
CREATE TABLE legacy_imports (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES legacy_instances(source_id),
  preview_hash TEXT NOT NULL,
  report_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
