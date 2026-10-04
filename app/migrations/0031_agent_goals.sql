-- Agent 增强 P4（Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md §4、§5.1、§6 P4）。
-- agent_goals：一次主人要求是一个目标；结果后的改口、回答后的续办、“继续这个目标”都在同一目标上提高 revision。
--   目标是业务流程状态（随业务导出与恢复），原话与结果仍在 conversations / intakes 里，不是另一套聊天记录。
-- agent_goal_revisions：每一版由哪份投递、什么原因产生（initial / revise / continue / cancel）。
-- intakes.goal_id / goal_revision：投递属于哪个目标的哪一版；不是当前版的投递不能再写入业务数据。

CREATE TABLE agent_goals (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  origin_intake_id TEXT NOT NULL,
  objective TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'awaiting_input', 'awaiting_confirmation', 'completed', 'partial', 'blocked', 'cancelled')),
  summary_json TEXT NOT NULL DEFAULT '{}',
  repair_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX ix_agent_goals_conversation ON agent_goals(conversation_id, updated_at);
CREATE INDEX ix_agent_goals_updated ON agent_goals(updated_at);

CREATE TABLE agent_goal_revisions (
  goal_id TEXT NOT NULL REFERENCES agent_goals(id),
  revision INTEGER NOT NULL,
  intake_id TEXT,
  cause TEXT NOT NULL CHECK (cause IN ('initial', 'revise', 'continue', 'cancel')),
  owner_text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (goal_id, revision)
);

ALTER TABLE intakes ADD COLUMN goal_id TEXT;
ALTER TABLE intakes ADD COLUMN goal_revision INTEGER;
CREATE INDEX ix_intakes_goal ON intakes(goal_id, goal_revision) WHERE goal_id IS NOT NULL;
