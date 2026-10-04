-- Agent 增强 P0（Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md §3.3、§6 P0）。
-- ai_request_ledger：按实际 HTTP 请求的持久额度账目。发出前原子占用；发出后即使超时/崩溃也保留占用；
--   只有确认没有发出的预留才标 released。日额度、单投递额度与累计执行时间都从这里计数，重启/恢复不重置。
-- agent_traces：每次模型决策的脱敏诊断记录（不含授权头、key、base64 图片），30 天 TTL，不入业务导出。
-- agent_feedback：主人“理解错了”的纠错，90 天 TTL，不入业务导出。

CREATE TABLE ai_request_ledger (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL,
  created_at TEXT NOT NULL,
  workflow TEXT NOT NULL,
  decision_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  intake_id TEXT,
  related_type TEXT,
  related_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('reserved', 'sent', 'ok', 'error', 'released')),
  duration_ms INTEGER,
  settled_at TEXT
);
CREATE INDEX ix_ai_request_ledger_date ON ai_request_ledger(local_date, status);
CREATE INDEX ix_ai_request_ledger_intake ON ai_request_ledger(intake_id) WHERE intake_id IS NOT NULL;
CREATE INDEX ix_ai_request_ledger_decision ON ai_request_ledger(decision_id);
CREATE INDEX ix_ai_request_ledger_created ON ai_request_ledger(created_at);

CREATE TABLE agent_traces (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  local_date TEXT NOT NULL,
  workflow TEXT NOT NULL,
  routed_by TEXT,                 -- model | rules | fast；非路由工作流为空
  intake_id TEXT,
  item_id TEXT,
  conversation_id TEXT,
  goal_id TEXT,
  related_type TEXT,
  related_id TEXT,
  protocol TEXT NOT NULL,
  model TEXT,
  prompt_version TEXT NOT NULL,   -- 指令文本 sha256 前缀
  schema_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'schema_invalid', 'error', 'budget', 'timeout')),
  error_code TEXT,
  error TEXT,
  attempts INTEGER NOT NULL,
  request_ids_json TEXT NOT NULL DEFAULT '[]',
  latency_ms INTEGER NOT NULL,
  request_json TEXT NOT NULL,     -- 脱敏：images 换成 sha256+字节数；整体封顶 20k 字符
  response_json TEXT,             -- 脱敏、封顶 20k 字符
  exchanges_json TEXT NOT NULL DEFAULT '[]',  -- 每次 HTTP：requestId、attempt、status、latency、截断后的原始输出
  tool_calls_json TEXT NOT NULL DEFAULT '[]', -- [{name,args,resultDigest,chars}]（P2 起使用）
  truncated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_agent_traces_date ON agent_traces(local_date);
CREATE INDEX ix_agent_traces_intake ON agent_traces(intake_id) WHERE intake_id IS NOT NULL;
CREATE INDEX ix_agent_traces_created ON agent_traces(created_at);

CREATE TABLE agent_feedback (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  intake_id TEXT NOT NULL,
  item_id TEXT,
  trace_id TEXT,
  goal_id TEXT,
  owner_text TEXT NOT NULL,
  routed_json TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('wrong_intent', 'wrong_object', 'should_ask', 'should_not_ask', 'other')),
  expected_text TEXT,
  exported_at TEXT
);
CREATE INDEX ix_agent_feedback_created ON agent_feedback(created_at);
