-- P6：focus 计时（§5.1 最多 1 个进行中）+ plan_sessions 成为唯一排程事实源（v1 旧排程一次性迁移）。

CREATE TABLE focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),
  note TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  paused_at TEXT,
  accumulated_minutes INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'paused', 'completed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- 最多 1 个进行中（部分唯一索引）
CREATE UNIQUE INDEX focus_one_in_progress ON focus_sessions(status) WHERE status = 'in_progress';

-- v1 旧排程（tasks.scheduled_start/end）一次性迁入 plan_sessions（locked=1 保留原安排，重排不动）。
-- 幂等：同 task+start 已存在则跳过（重跑迁移不产生重复）。
INSERT INTO plan_sessions (id, task_id, start_utc, end_utc, timezone, status, locked, batch_id, version, created_at, updated_at)
SELECT lower(hex(randomblob(16))), t.id, t.scheduled_start, t.scheduled_end,
       COALESCE(t.planned_week_timezone, 'Asia/Shanghai'), 'planned', 1, NULL, 1, t.updated_at, t.updated_at
FROM tasks t
WHERE t.scheduled_start IS NOT NULL AND t.scheduled_end IS NOT NULL
  AND t.archived_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM plan_sessions ps WHERE ps.task_id = t.id AND ps.start_utc = t.scheduled_start);
