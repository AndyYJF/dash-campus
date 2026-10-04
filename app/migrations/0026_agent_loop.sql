-- R2：Agent 闭环所需的持久结构（REPAIR-PLAN §4.1.1/§5，AGENT-INTERFACE-CONTRACT §5/§8）。
-- 对话与问答保存在服务端；问题带用途与上下文；任务有暂停与主人报告的剩余需求；学习块带安排依据。

-- 任务：暂停到某天（一次暂停不是撤销）；主人报告的剩余需求（deliverable 不用“估时−已花”硬推）
ALTER TABLE tasks ADD COLUMN paused_until TEXT;
ALTER TABLE tasks ADD COLUMN remaining_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN remaining_reported_at TEXT;

-- 学习块：安排依据（给人看的解释）、类型（未知工作量的起步块只排一次）、来源（主人指定的位置不被自动挪）
ALTER TABLE plan_sessions ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE plan_sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'starter'));
ALTER TABLE plan_sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent' CHECK (origin IN ('agent', 'user'));

-- 实践记录与计时/学习块的关联证据（同一活动只扣一次，按关联而非分钟相近）
ALTER TABLE practice_entries ADD COLUMN plan_session_id TEXT;
ALTER TABLE practice_entries ADD COLUMN focus_session_id TEXT;

-- 对话：刷新/换设备后继续；turn 记录主人原话、Agent 结果与涉及的对象引用
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE conversation_turns (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'agent')),
  intake_id TEXT,
  question_id TEXT,
  text TEXT NOT NULL DEFAULT '',
  refs_json TEXT NOT NULL DEFAULT '[]',     -- 这一轮涉及的实体引用，供“刚才那个”消解
  batch_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);
CREATE INDEX idx_conversation_turns_conv ON conversation_turns(conversation_id, seq);

ALTER TABLE intakes ADD COLUMN conversation_id TEXT;
ALTER TABLE intakes ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';  -- questionId / selectedEntityRef / 时段上下文

-- 通用问题：用途决定回答由哪个解析器处理；context 带目标引用、读版本、默认建议（建议不是已提交答案）
ALTER TABLE clarification_questions ADD COLUMN purpose TEXT NOT NULL DEFAULT 'semester_anchor';
ALTER TABLE clarification_questions ADD COLUMN reason TEXT NOT NULL DEFAULT '';
ALTER TABLE clarification_questions ADD COLUMN context_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE clarification_questions ADD COLUMN conversation_id TEXT;

-- 变更批次：由哪个批次引起（修改触发的重排是独立批次）；属于哪次对话
ALTER TABLE agent_action_batches ADD COLUMN caused_by TEXT;
ALTER TABLE agent_action_batches ADD COLUMN conversation_id TEXT;

-- intake_items.kind 增加 command（主人的直接指令）、calendar（校历）、holiday（节假日通知）、adjustment（调课通知）。
-- 与 0021 相同的做法：先断开 clarification_questions.item_id 引用 → 重建 → 恢复引用。
CREATE TABLE intake_items_new (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intakes(id),
  stable_item_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('timetable', 'notice', 'practice', 'task', 'note', 'ics', 'command', 'calendar', 'holiday', 'adjustment')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'extracted'
    CHECK (state IN ('extracted','resolving','awaiting_input','ready','applied','ignored','failed','cancelled')),
  evidence_json TEXT,
  waiting_question_id TEXT REFERENCES clarification_questions(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (intake_id, stable_item_key)
);

CREATE TEMP TABLE _item_ref_map_26 AS
  SELECT id, item_id FROM clarification_questions WHERE item_id IS NOT NULL;
UPDATE clarification_questions SET item_id = NULL WHERE item_id IS NOT NULL;

INSERT INTO intake_items_new
  SELECT id, intake_id, stable_item_key, kind, payload_json, state, evidence_json, waiting_question_id, version, created_at, updated_at
  FROM intake_items;

DROP TABLE intake_items;
ALTER TABLE intake_items_new RENAME TO intake_items;
CREATE INDEX intake_items_intake ON intake_items(intake_id);

UPDATE clarification_questions
  SET item_id = (SELECT m.item_id FROM _item_ref_map_26 m WHERE m.id = clarification_questions.id)
  WHERE id IN (SELECT id FROM _item_ref_map_26);
DROP TABLE _item_ref_map_26;
