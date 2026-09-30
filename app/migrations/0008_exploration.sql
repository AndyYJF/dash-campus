-- T5 探索与实践（计划 v1.2 第 4.2、7 节）
-- exploration_topics / exploration_runs / search_hits / evidence_documents / candidates / practice_templates
-- run 关联 topic 或手动请求；candidate 有 canonical_url 和 evidence_hash；原文版本不可变

CREATE TABLE practice_templates (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  -- draft：来源与许可未核实，不能当成完整课程内容（7.1）
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready')),
  direction TEXT NOT NULL,
  question TEXT NOT NULL,
  activities_json TEXT NOT NULL DEFAULT '[]',
  prerequisites_json TEXT NOT NULL DEFAULT '[]',
  required_resources_json TEXT NOT NULL DEFAULT '[]',
  estimated_minutes_min INTEGER,
  estimated_minutes_max INTEGER,
  deliverables_json TEXT NOT NULL DEFAULT '[]',
  first_step TEXT NOT NULL DEFAULT '',
  initial_tasks_json TEXT NOT NULL DEFAULT '[]',
  review_questions_json TEXT NOT NULL DEFAULT '[]',
  source_links_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (estimated_minutes_min IS NULL OR estimated_minutes_max IS NULL OR estimated_minutes_min <= estimated_minutes_max)
);

CREATE TABLE exploration_topics (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  source_preference TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  -- 定期默认每周一次，用户明确开启并选择本地时间（7.2）
  weekday INTEGER NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 1 AND 7),
  local_time TEXT NOT NULL DEFAULT '09:00',
  timezone TEXT NOT NULL,
  next_run_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_topics_next_run ON exploration_topics(enabled, next_run_at);

CREATE TABLE exploration_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('on_demand', 'scheduled')),
  topic_id TEXT REFERENCES exploration_topics(id),
  -- 定期 run 记录入队时的 topic 版本，发布前重检（F16）
  topic_version INTEGER,
  project_id TEXT REFERENCES projects(id),
  query TEXT NOT NULL,
  -- 实际阶段，不用虚构百分比（产品计划 5）
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'searching', 'extracting', 'generating', 'done', 'failed', 'cancelled')),
  -- fixture 结果必须单独标识，不能当成真实联网
  integration_mode TEXT NOT NULL CHECK (integration_mode IN ('real', 'fixture', 'materials_only')),
  job_id TEXT REFERENCES jobs(id),
  error_code TEXT,
  error_message TEXT,
  budget_json TEXT NOT NULL DEFAULT '{}',
  diagnostics_json TEXT NOT NULL DEFAULT '[]',
  materials_json TEXT NOT NULL DEFAULT '[]',
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_runs_created ON exploration_runs(created_at);
CREATE INDEX idx_runs_topic ON exploration_runs(topic_id);

CREATE TABLE search_hits (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES exploration_runs(id),
  query TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  snippet TEXT,
  published_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_hits_run ON search_hits(run_id);

-- 原文版本不可变：只插入，不更新
CREATE TABLE evidence_documents (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES exploration_runs(id),
  hit_id TEXT REFERENCES search_hits(id),
  url TEXT,
  canonical_url TEXT,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('snippet', 'retrieved', 'user_supplied')),
  content_hash TEXT NOT NULL,
  published_at TEXT,
  retrieved_at TEXT NOT NULL
);
CREATE INDEX idx_evidence_run ON evidence_documents(run_id);

CREATE TABLE candidates (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES exploration_runs(id),
  topic_id TEXT REFERENCES exploration_topics(id),
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  activities_json TEXT NOT NULL DEFAULT '[]',
  deliverable TEXT NOT NULL DEFAULT '',
  first_task_json TEXT NOT NULL,
  initial_tasks_json TEXT NOT NULL DEFAULT '[]',
  estimated_minutes_min INTEGER,
  estimated_minutes_max INTEGER,
  -- [{label,status:met|unmet|unknown,basis,confirmedByOwner}]；met 只能由主人确认
  requirements_json TEXT NOT NULL DEFAULT '[]',
  unknowns_json TEXT NOT NULL DEFAULT '[]',
  fit_reason TEXT NOT NULL DEFAULT '',
  -- [{evidenceId, quote}]，quote 已由程序验证存在于证据文本
  source_refs_json TEXT NOT NULL,
  evidence_status TEXT NOT NULL CHECK (evidence_status IN ('snippet', 'retrieved', 'user_supplied')),
  canonical_url TEXT,
  evidence_hash TEXT NOT NULL,
  supersedes_id TEXT REFERENCES candidates(id),
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'idea', 'started', 'dismissed')),
  feedback TEXT CHECK (feedback IS NULL OR feedback IN ('not_interested', 'lacking_basics', 'no_time', 'low_quality')),
  project_id TEXT REFERENCES projects(id),
  started_with_unknowns INTEGER NOT NULL DEFAULT 0 CHECK (started_with_unknowns IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (estimated_minutes_min IS NULL OR estimated_minutes_max IS NULL OR estimated_minutes_min <= estimated_minutes_max)
);
CREATE INDEX idx_candidates_run ON candidates(run_id);
CREATE INDEX idx_candidates_topic_url ON candidates(topic_id, canonical_url);

-- 7.3 探索结束：开始倾向 + 本人结论；报告只引用用户自己的结论
ALTER TABLE projects ADD COLUMN candidate_id TEXT REFERENCES candidates(id);
ALTER TABLE projects ADD COLUMN start_inclination TEXT CHECK (start_inclination IS NULL OR start_inclination IN ('unknown', 'interested', 'unsure'));
ALTER TABLE projects ADD COLUMN experienced_activities TEXT;
ALTER TABLE projects ADD COLUMN conclusion TEXT CHECK (conclusion IS NULL OR conclusion IN ('continue', 'change', 'undecided'));
ALTER TABLE projects ADD COLUMN conclusion_reason TEXT;
ALTER TABLE projects ADD COLUMN conclusion_artifact_ids_json TEXT;
ALTER TABLE projects ADD COLUMN concluded_at TEXT;

-- 首版 3 个可编辑模板（7.1）。均为 draft：具体数据/教程来源与许可需主人核实后才可改 ready
INSERT INTO practice_templates (id, version, status, direction, question, activities_json, prerequisites_json,
  required_resources_json, estimated_minutes_min, estimated_minutes_max, deliverables_json, first_step,
  initial_tasks_json, review_questions_json, source_links_json, created_at, updated_at)
VALUES
('tpl-classification-baseline', 1, 'draft', '机器学习入门',
 '一个简单分类基线能做到什么程度，错误主要集中在哪里？',
 '["选一个公开的小型表格或文本分类数据集","训练一个最简单的基线（如逻辑回归）","按类别整理错分样本并归纳原因"]',
 '["会写基础 Python","了解训练集/测试集的区别"]',
 '["一台普通电脑即可，无需 GPU","可公开下载且许可允许学习使用的数据集（待核实）"]',
 240, 480,
 '["基线指标表","20 条错分样本的归类笔记"]',
 '确定一个数据集并记录它的来源与许可',
 '[{"title":"选定数据集并记录来源与许可","estimateMinutes":45},{"title":"跑通最简单的基线并记录指标","estimateMinutes":90},{"title":"整理 20 条错分样本并归类","estimateMinutes":90}]',
 '["错误主要来自数据还是模型？","我是否愿意继续做更深入的错误分析？"]',
 '[]', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
('tpl-text-retrieval', 1, 'draft', '信息检索',
 '在少量文本上，关键词检索和向量检索的结果差别有多大？',
 '["准备几十篇短文本和 10 个查询","分别用关键词检索与一种向量检索跑同样的查询","人工标注每个查询前 5 条结果是否相关并对比"]',
 '["会写基础 Python","能安装常见 Python 包"]',
 '["普通电脑即可","一份许可允许使用的小型文本集合（待核实）"]',
 180, 420,
 '["两种方法的对比表","对差异原因的简短说明"]',
 '收集 30–50 篇短文本并写下 10 个查询',
 '[{"title":"收集文本与查询，记录来源","estimateMinutes":60},{"title":"实现关键词检索并记录结果","estimateMinutes":60},{"title":"实现向量检索并人工对比前 5 条","estimateMinutes":120}]',
 '["哪种查询两种方法差别最大？","这类工作是否让我想继续了解检索？"]',
 '[]', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z'),
('tpl-timing-comparison', 1, 'draft', '系统与性能',
 '同一段程序或模型推理，换一种实现方式能快多少？测量是否可信？',
 '["选一段可重复运行的程序或小模型推理","设计计时方法（多次运行、预热、记录环境）","对比两种实现并解释差异"]',
 '["会写基础程序","了解平均值与波动的含义"]',
 '["普通电脑即可","记录硬件与软件版本"]',
 120, 300,
 '["计时对比表（含多次运行的波动）","环境记录与结论"]',
 '选定要比较的两种实现并写下预期',
 '[{"title":"选定对比对象并写下预期","estimateMinutes":30},{"title":"写计时脚本并记录环境","estimateMinutes":60},{"title":"多次运行、整理结果并解释差异","estimateMinutes":90}]',
 '["测量结果和预期是否一致？","我是否对性能分析感兴趣？"]',
 '[]', '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z');
