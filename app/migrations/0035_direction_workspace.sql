-- 方向页打磨（D1）：主人确认的阶段与去向、关注方向、采用的阶段项、项目关联、实践感受、线索的方向上下文。
-- 只保存主人明确选择/采用/说过的内容；四年模板与工作样本是代码里的编辑内容，不落库、不批量生成目标或任务。
-- 已有项目/候选/实践/资料关系原样保留；旧项目没有方向关联时显示“未关联”，不猜、不强制分类。

-- 单例：当前阶段由主人确认（不从任务数推算），入学年可以不知道；去向偏好可多选并存，未选不代表排除
CREATE TABLE direction_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  confirmed_stage TEXT CHECK (confirmed_stage IS NULL OR confirmed_stage IN ('year1', 'year2', 'year3', 'year4')),
  -- 阶段从哪来：owner（主人在页面/对话里明确说的）或 intake 引用，便于说明依据
  stage_source TEXT NOT NULL DEFAULT '',
  entry_year INTEGER CHECK (entry_year IS NULL OR entry_year BETWEEN 2000 AND 2100),
  path_preferences_json TEXT NOT NULL DEFAULT '[]',
  basis_refs_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 关注方向：状态由主人选择；试做/正式投入从关联项目的 engagement 派生，不另存第二份项目状态
CREATE TABLE direction_tracks (
  id TEXT PRIMARY KEY,
  template_key TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'exploring' CHECK (status IN ('exploring', 'following', 'paused')),
  owner_notes TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_direction_tracks_template ON direction_tracks(template_key) WHERE template_key IS NOT NULL;

-- 主人采用/修订的阶段项；completed 只在主人明确确认时写入，累计时长不触发
CREATE TABLE roadmap_items (
  id TEXT PRIMARY KEY,
  stage_key TEXT NOT NULL CHECK (stage_key IN ('year1', 'year2', 'year3', 'year4')),
  title TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  goal_id TEXT REFERENCES goals(id),
  track_id TEXT REFERENCES direction_tracks(id),
  status TEXT NOT NULL DEFAULT 'adopted' CHECK (status IN ('adopted', 'completed', 'paused')),
  basis_refs_json TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_roadmap_items_stage ON roadmap_items(stage_key, status);

-- 项目可以跨方向；投入统计仍按项目只算一次
CREATE TABLE direction_project_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  track_id TEXT NOT NULL REFERENCES direction_tracks(id),
  roadmap_item_id TEXT REFERENCES roadmap_items(id),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, track_id)
);
CREATE INDEX idx_direction_project_links_track ON direction_project_links(track_id);

-- 主人的实践感受：原话必留；关联实际实践时引用 practice_entry_id，不再记一份分钟数
CREATE TABLE direction_reflections (
  id TEXT PRIMARY KEY,
  original_text TEXT NOT NULL,
  -- AI 整理的摘要（可再生成），界面标为整理，不当主人原话
  summary TEXT NOT NULL DEFAULT '',
  occurred_on TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  track_id TEXT REFERENCES direction_tracks(id),
  practice_entry_id TEXT REFERENCES practice_entries(id),
  source_intake_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (project_id IS NOT NULL OR track_id IS NOT NULL OR practice_entry_id IS NOT NULL)
);
CREATE INDEX idx_direction_reflections_track ON direction_reflections(track_id, occurred_on);
CREATE INDEX idx_direction_reflections_project ON direction_reflections(project_id, occurred_on);

-- 主人线索的方向/阶段上下文：仍是 resources + resource_links，默认 reference，不自动变成果或任务
ALTER TABLE resource_links ADD COLUMN track_id TEXT REFERENCES direction_tracks(id);
ALTER TABLE resource_links ADD COLUMN stage_key TEXT CHECK (stage_key IS NULL OR stage_key IN ('year1', 'year2', 'year3', 'year4'));
ALTER TABLE resource_links ADD COLUMN note_kind TEXT CHECK (note_kind IS NULL OR note_kind IN ('advice', 'policy', 'opportunity', 'industry', 'question', 'other'));
