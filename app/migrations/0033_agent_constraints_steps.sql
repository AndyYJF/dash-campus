-- Agent 语义修复（Plan/dash-campus-AGENT-SEMANTIC-REPAIR-PROMPT-2026-10-05.md W1/W3）。
-- agent_goal_constraints：目标上主人说过的条件（范围、周末/工作日保护、具体日期与对象保护、几点后不排）。
--   约束是有类型的（kind + value_json 由 zod 判别联合校验），带来源：主人原话/回答里的逐字引用、哪一版、哪份投递。
--   模型只能提出候选；引用不在主人本人的话里的不入库。范围类约束以最新一版为准，保护类约束跨版本保留，直到主人明说解除。
--   同一对话里新开的目标沿用上一件事仍生效的保护类约束（周末/日期/对象不动；source = inherited，引用保持主人原话），也要主人明说才解除。
-- agent_step_executions：每个执行步骤的稳定执行凭据。与领域写入在同一事务提交，记下结果引用
--   （变更批次、探索 run、任务 job、复盘、导出、投递），恢复重跑时按凭据认领原结果，不再产生第二次副作用。
--   主人新的要求是新的事项，凭据不同，不会被误认成重复。
-- 两张表都是目标的业务流程状态，随业务导出与恢复。

CREATE TABLE agent_goal_constraints (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL REFERENCES agent_goals(id),
  revision INTEGER NOT NULL,
  intake_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('date_scope', 'protect_days', 'protect_dates', 'protect_entity', 'no_study_after', 'note')),
  value_json TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('owner_text', 'owner_answer', 'rule_parse', 'inherited')),
  status TEXT NOT NULL DEFAULT 'accepted' CHECK (status IN ('accepted', 'released', 'superseded')),
  released_revision INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX ix_agent_goal_constraints_goal ON agent_goal_constraints(goal_id, status);

CREATE TABLE agent_step_executions (
  item_id TEXT NOT NULL,
  command TEXT NOT NULL,
  intake_id TEXT,
  batch_id TEXT,
  effects_json TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (item_id, command)
);
CREATE INDEX ix_agent_step_executions_intake ON agent_step_executions(intake_id) WHERE intake_id IS NOT NULL;
