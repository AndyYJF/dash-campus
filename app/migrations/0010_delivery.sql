-- T7 自部署交付（计划 v1.2 第 9、10 节）：导出、恢复暂停状态

-- 导出文件保存在实例私有目录，24 小时后过期；下载 GET 不触发重新生成
CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('project_markdown', 'full_json')),
  selected_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('ready', 'failed', 'expired', 'deleted')),
  file_name TEXT NOT NULL,
  private_path TEXT,
  byte_size INTEGER,
  expires_at TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_exports_created ON exports(created_at);

-- 实例运行控制（单行）：restore 命令写入 restored_hold 并递增 deployment_epoch；
-- hold 期间 worker 不发起任何邮件、搜索、模型请求，直到主人显式 resume
CREATE TABLE instance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  restored_hold INTEGER NOT NULL DEFAULT 0 CHECK (restored_hold IN (0, 1)),
  deployment_epoch INTEGER NOT NULL DEFAULT 0,
  restored_at TEXT,
  restored_from TEXT,
  resumed_at TEXT,
  -- worker 每趟轮询写入；restore 用它确认本机 worker 已停止
  worker_heartbeat_at TEXT
);
INSERT INTO instance_state (id) VALUES (1);

-- 恢复出来的旧 job：保持原状态但挂起，不被领取；resume 时统一取消
ALTER TABLE jobs ADD COLUMN hold_state TEXT CHECK (hold_state IS NULL OR hold_state = 'restored_pending');
