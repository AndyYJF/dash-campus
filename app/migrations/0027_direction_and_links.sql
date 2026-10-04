-- R2/R5：方向闭环与资料归属（REPAIR-PLAN §5.2/§5.3，AGENT-INTERFACE-CONTRACT §2）。

-- 计时与学习块的明确关系（从行动卡开始计时）
ALTER TABLE focus_sessions ADD COLUMN plan_session_id TEXT;

-- 目标优先级：最多一个主要方向（priority=1）
ALTER TABLE goals ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

-- 项目投入程度：trial = 试做（有期限、不等于对外承诺）；committed = 正式投入（需主人明确意图）
ALTER TABLE projects ADD COLUMN engagement TEXT NOT NULL DEFAULT 'committed' CHECK (engagement IN ('trial', 'committed'));
ALTER TABLE projects ADD COLUMN trial_until TEXT;

-- 资料与项目/任务的关联及事实类型：reference 参考资料 / requirement 别人的要求 / achievement 自己完成的成果。
-- origin=user 的纠正优先于后续来源同步，不被覆盖。
CREATE TABLE resource_links (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('project', 'task', 'none')),
  entity_id TEXT,
  role TEXT NOT NULL DEFAULT 'reference' CHECK (role IN ('reference', 'requirement', 'achievement')),
  origin TEXT NOT NULL DEFAULT 'assumed' CHECK (origin IN ('user', 'assumed')),
  locator TEXT NOT NULL DEFAULT '',      -- 原件定位（哪次投递、哪段原文）
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_resource_links_resource ON resource_links(resource_id);
CREATE INDEX idx_resource_links_entity ON resource_links(entity_kind, entity_id);
