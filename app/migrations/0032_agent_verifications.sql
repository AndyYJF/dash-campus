-- Agent 增强 P5（Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md §5.2、§5.3、§6 P5）。
-- agent_verifications：一份投递（= 目标的一版）执行后的每一轮核验与它之前做的修正。
--   核验条件由服务端按操作模板生成并读回当前事实判定，模型不能改写；
--   修正最多 2 次、每次最多 4 步，同一失败指纹不重复尝试；轮次持久化，worker 恢复后不重置。
--   这是目标的业务流程状态，随业务导出与恢复。

CREATE TABLE agent_verifications (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL,
  goal_id TEXT,
  goal_revision INTEGER,
  round INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('verified', 'partial', 'needs_action', 'blocked', 'pending')),
  checks_json TEXT NOT NULL DEFAULT '[]',
  fingerprint TEXT,
  repair_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (intake_id, round)
);
CREATE INDEX ix_agent_verifications_goal ON agent_verifications(goal_id, goal_revision) WHERE goal_id IS NOT NULL;
