-- Agent-first V2 P1：统一输入（intake）、提取证据、分类事项与主动问答。
-- 状态机见 docs/agent-first-v2/MASTER-PLAN.md §4.1；同一缺口最多 1 个 open 问题由部分唯一索引保证（§2.3）。

-- 接收记录：提交即持久化（durable receipt），不等模型
CREATE TABLE intakes (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,                -- web / api；来源适配器后续复用同一 envelope
  text TEXT NOT NULL DEFAULT '',
  reference_date TEXT NOT NULL,         -- 提交时的当地日期（相对日期解析锚点）
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processing','waiting_input','partially_applied','completed','failed','cancelled')),
  version INTEGER NOT NULL DEFAULT 1,
  instance_epoch INTEGER NOT NULL,      -- 旧 epoch 的 job/请求不得写入新 epoch（§9.1）
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 提取证据：保留原出处；附件在 P4 引入 intake_attachments，文本阶段的证据即规范化正文
CREATE TABLE extracted_documents (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intakes(id),
  source_kind TEXT NOT NULL,            -- text；P4 扩展 image/pdf/xlsx/csv/ics/url
  extractor_version TEXT NOT NULL,
  content_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,           -- sha256；只用于复用提取结果，不去重用户意图（§5.3）
  locator TEXT,                         -- 页码/单元格/区域；文本阶段为 NULL
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('done','failed')),
  created_at TEXT NOT NULL
);
CREATE INDEX extracted_documents_intake ON extracted_documents(intake_id);

-- 分类后的独立事项：一份材料拆多个 item，各自推进（§4.1）
CREATE TABLE intake_items (
  id TEXT PRIMARY KEY,
  intake_id TEXT NOT NULL REFERENCES intakes(id),
  stable_item_key TEXT NOT NULL,        -- 重跑/恢复时同一事项不重复（intake 内唯一）
  kind TEXT NOT NULL CHECK (kind IN ('timetable','notice','practice','task','note')),
  payload_json TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'extracted'
    CHECK (state IN ('extracted','resolving','awaiting_input','ready','applied','ignored','failed','cancelled')),
  evidence_json TEXT,                   -- 逐字引用等证据
  waiting_question_id TEXT REFERENCES clarification_questions(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (intake_id, stable_item_key)
);
CREATE INDEX intake_items_intake ON intake_items(intake_id);

-- 必要问题：open 状态对 question_key 唯一（多份材料共享同一缺口）
CREATE TABLE clarification_questions (
  id TEXT PRIMARY KEY,
  question_key TEXT NOT NULL,           -- 如 semester.first_monday
  intake_id TEXT REFERENCES intakes(id),
  item_id TEXT REFERENCES intake_items(id),
  field_path TEXT NOT NULL,             -- 所缺字段
  prompt TEXT NOT NULL,                 -- 为什么需要、问什么
  options_json TEXT,                    -- 可选答案；NULL 表示仅自由输入
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','answered','deferred','superseded')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX clarification_questions_one_open
  ON clarification_questions(question_key) WHERE status = 'open';

CREATE TABLE clarification_answers (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES clarification_questions(id),
  raw_text TEXT NOT NULL,
  structured_json TEXT,                 -- 解析后的结构值（如 firstMonday）
  submitted_at TEXT NOT NULL
);
CREATE INDEX clarification_answers_question ON clarification_answers(question_id);
