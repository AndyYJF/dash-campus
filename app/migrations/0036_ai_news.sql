CREATE TABLE ai_news_runs (
 id TEXT PRIMARY KEY, trigger TEXT NOT NULL CHECK(trigger IN ('manual','scheduled')),
 status TEXT NOT NULL CHECK(status IN ('queued','running','ready','empty','failed','cancelled')),
 days INTEGER NOT NULL, policy_version INTEGER NOT NULL, job_id TEXT REFERENCES jobs(id),
 sources_json TEXT NOT NULL DEFAULT '[]', digest_json TEXT, warnings_json TEXT NOT NULL DEFAULT '[]',
 integration_mode TEXT, error_message TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, generated_at TEXT
);
CREATE UNIQUE INDEX ai_news_one_active ON ai_news_runs((1)) WHERE status IN ('queued','running');
CREATE INDEX ai_news_recent ON ai_news_runs(created_at DESC);
