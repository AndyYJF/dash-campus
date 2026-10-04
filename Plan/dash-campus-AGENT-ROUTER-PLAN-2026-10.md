# 自研 Agent 开工方案：模型优先路由 + 有界只读工具

日期：2026-10-04。状态：待实施规划，未开发。适用基线：[AndyYJF/dash-campus](https://github.com/AndyYJF/dash-campus) `main` @ `503552c`（业务版本 `95c8cf1`，schema 29）。开工时以仓库最新代码重新核对实现状态与迁移最大号。

本文件补充 [Agent 操作与接口契约](https://github.com/AndyYJF/dash-campus/blob/main/app/docs/agent-first-v2/AGENT-INTERFACE-CONTRACT.md) 与 [决策记录](https://github.com/AndyYJF/dash-campus/blob/main/app/docs/decisions.md)。不替代 E01–E49 验收，不改变 Todo 只读、自研有限步骤 Agent、不换框架等既有硬边界。

---

## 0. 主人已确认的取舍

| 问题 | 结论 |
|---|---|
| 本轮主线 | 自然语言理解：不常见说法也能被正确理解，不再依赖逐条追加正则 |
| 模型端点能力 | 支持原生 function/tool calling 与视觉输入（P0 仍需实测并持久化） |
| 模型优先路由 | 接受。除 `/指令` 与少数快路径外，自然语言默认先走 1 次模型理解；每日模型预算上调至 100–200 次 |
| 只读工具循环 | 允许。一次决策内最多 3 轮只读工具 + 1 次输出；写操作仍只经白名单命令 |
| 执行方式 | 交给 Coding Agent 分包执行，总周期约 2–3 周，每包独立验收 |
| 真实模型评测 | 投入。每次回归约 100–300 次真实调用，脱敏保存请求/响应用于回放 |

---

## 1. 现状诊断

### 1.1 应保留的骨架

- **执行层边界扎实**：36 个 Zod 白名单操作（`contracts/commands.ts`）、服务端绑定对象 ID、journal/undo、版本与 epoch 防护、jobs 租约 fencing、每日次数预算、excerpt 必须逐字来自原文、外部文本只当数据。这些是后续扩展自由度的安全网。
- **模型/算法分工清楚**：模型选取舍，排程、预算账本、冲突由确定性算法计算（decisions 2026-10-04）。
- **Intake 流水线与问答生命周期合理**：durable receipt → extract → classify → resolve → policy → command；questionKey 去重、按 purpose 解析回答、回答后从 Resolve 恢复。

### 1.2 主要瓶颈：正则优先、模型补位

1. **理解的第一道门是正则**。`domain/intent.ts` 约 470 行、数十条按序匹配的中文正则；模型只在正则认不出或分类为 `command` 时才给意图。线上两次误判（“看一下目前每天的时间安排”被建成任务；“根据每天的课程重新安排时间”因缺钟点被拒）本质都是正则覆盖面问题，每修一次就是再加一条正则和一组回归测试，边际成本持续上升。
2. **模型没有读工具**。`adjustment_decision` 把 7 天快照 + 最多 100 条任务一次性塞进 context，模型一次决定，无法“先查再决定”。契约 §4 已写 `get_context / find_entities / get_entity_detail / get_budget_and_calendar / get_evidence`，代码中尚无。
3. **模型决策只开放给时间调整**。`adjustment-decision.ts` 的 `ALLOWED` 只有 13 个 op，其余 30 多个操作仍依赖正则命中。
4. **操作注册表只有 schema，没有元数据**。缺默认授权级别、影响实体、撤销类型、所需读集；工具说明、确认策略、按钮能力分散手写，prompt 中的 op 列表与代码可能漂移。
5. **没有真实模型评测闭环**。337 个隔离用例全部使用假件，能守流程正确性，守不住提示词回归；`ai_usage` 只记次数与 token，不记请求/响应，线上理解偏差无法回放。
6. **Provider 协议偏保守**。只用 `response_format: json_object`，未用 strict json_schema 与原生 tool calling；能力探测结果未持久化。

### 1.3 STATUS 中已列、本轮不处理的缺口

真实复杂视觉验证、真实邮件收件、作息确认、主人七天试用、部分 v1 写接口未并入统一操作。本轮只为视觉留能力探测接口。

---

## 2. 目标与非目标

### 2.1 目标（可量化）

- 评测语料（≥200 句真实/拟真表达）上意图识别准确率 ≥ 90%；“查看”误建任务 = 0；“模糊调整”被拒 = 0。
- 每条自然语言输入默认 ≤ 4 次模型 HTTP 请求（1 次路由 + ≤3 轮工具）；单份投递总上限 10 次。
- 每次模型理解都有脱敏 trace 可回放；主人可在结果卡标“理解错了”，反馈进入语料。

### 2.2 非目标

- 不改排程器、预算账本、提醒状态机、邮件、Todo 只读桥接。
- 不提升视觉提取质量（只做能力探测与持久化）。
- 不改版 UI（只在结果详情增加“理解依据”与反馈按钮）。
- 不引入外部 Agent 框架；不给模型写工具、任意 SQL、任意 HTTP；不加常驻循环、Redis、向量库或第二套对话存储。
- 不删除正则：降级路径必须存在。

---

## 3. 架构变化

只改“理解层”，执行层不动。

```text
现状                                        目标
owner text                                  owner text
  │                                            │
  ├─ /指令 → 确定性 ──────────────┐            ├─ /指令、纯“撤销”、对open问题的是/否 → 快路径 ──┐
  │                                │            │                                                 │
  ├─ parseInstruction（正则） ─────┤            ├─ agent_route（模型：1次 + ≤3轮只读工具） ───────┤
  │     认不出 ↓                    │            │     • items[].intents（扩展后的 intentSchema）   │
  ├─ isFlexibleAdjustment（正则）──┤            │     • material（剩余原文交材料分类）             │
  │     → adjustment_decision 模型  │            │     • ask（一个具体问题）                        │
  │                                │            │   模型不可用 / 超预算 ↓ 降级                     │
  └─ 分类模型（材料） ─────────────┤            ├─ parseInstruction + isFlexibleAdjustment（降级） ┤
                                   ↓            └─ 分类模型（材料，不变） ─────────────────────────┤
              bindIntents → 注册操作 → journal/undo → 排程器                              （完全不变）↓
```

不变的硬边界：

1. 模型只产出 `Intent`，对象绑定在服务端。
2. 写操作只经 `contracts/commands.ts` 白名单。
3. journal/undo/版本/epoch/租约/预算全部复用。
4. 工具结果与材料都是数据，不是指令。

新增边界：

5. **模型引用的 ID 只能来自本轮工具结果、对话 refs 或卡片 selected**。服务端维护 seen-set，越界直接 fail，不猜。

---

## 4. 关键设计决策（实施后写入 decisions.md）

| # | 决策 | 理由 |
|---|---|---|
| D1 | 模型优先路由，正则降为快路径与降级 | 正则的边际维护成本已高于一次模型调用；降级保证模型不可用时功能不退化 |
| D2 | 只读工具 ≤3 轮；工具是纯函数，不经模型、不联网、输出封顶 4k 字 | 让模型先查再决定，又不成为无边界循环 |
| D3 | 操作注册表元数据化；意图目录与工具说明由注册表和 zod schema 生成 | 契约 §4 已要求；消除 prompt 手写 op 列表与代码漂移 |
| D4 | `adjustment_decision` 的 `ALLOWED/TEMPORARY` 泛化为注册表授权级别 `auto / explicit / confirm / never` | 让“先查后决、追问续答”扩展到全部业务，不再按领域各写一套 |
| D5 | 模型请求/响应脱敏落 `agent_traces`，30 天 TTL，不进业务导出 | 没有回放就没有评测；模型中间产物不能当事实导出 |
| D6 | 评测三层：隔离假件（流程）→ 录制回放（提示词回归，CI）→ 真实模型（本地/发布前，预算封顶） | 假件守不住提示词回归 |
| D7 | 主人纠错进入语料 | 单用户产品最好的标注员是主人本人 |

---

## 5. 工作包（P0–P5，约 16–19 个工作日）

每包完成后独立验收再进入下一包；只跑受影响测试，不空跑全部门禁。

### P0 · 基线、能力探测、trace（1.5 天）

**交付**

- `scripts/dev/probe-model-caps.mts`：探测 `tools`（function calling）、`jsonSchema`（strict）、`vision`，写入 settings 键：

  ```ts
  modelCapabilities = { vision: boolean; tools: boolean; jsonSchema: boolean; model: string; probedAt: string }
  ```

  `/settings` 集成状态卡展示；`resolveModelProvider()` 读取该键决定协议分支。可参考现有 `scripts/dev/probe-model-vision.mjs`。
- `integrations/model-json.ts`：`jsonSchema=true` 时使用 `response_format: { type: "json_schema", json_schema: { strict: true, schema: z.toJSONSchema(req.schema) } }`，否则维持 `json_object`。修复 1 次的机制不变。
- 迁移 `0030_agent_traces.sql`：

  ```sql
  CREATE TABLE agent_traces (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    local_date TEXT NOT NULL,
    workflow TEXT NOT NULL,
    intake_id TEXT,
    item_id TEXT,
    conversation_id TEXT,
    model TEXT,
    protocol TEXT,
    status TEXT NOT NULL,          -- ok | schema_invalid | error | budget
    requests INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    request_json TEXT NOT NULL,    -- 脱敏：无 key；images 换成 sha256+尺寸；文本封顶 20k
    response_json TEXT,
    tool_calls_json TEXT,          -- [{name,args,resultDigest,chars}]
    error TEXT
  );
  CREATE INDEX ix_agent_traces_date ON agent_traces(local_date);

  CREATE TABLE agent_feedback (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    intake_id TEXT NOT NULL,
    item_id TEXT,
    trace_id TEXT,
    owner_text TEXT NOT NULL,
    routed_json TEXT NOT NULL,
    verdict TEXT NOT NULL,         -- wrong_intent | wrong_object | should_ask | should_not_ask | other
    expected_text TEXT,
    exported_at TEXT
  );
  ```

  两表加入导出分类测试的“排除”列表；worker 每趟清理 30 天前的 trace；`EXPECTED_SCHEMA_VERSION = 30`。
- `meteredModel()`（`workflows/ai-budget.ts`）在成功与失败时都写 trace，`ai_usage` 行为不变。
- 预算：`aiBudgetSchema.dailyModelCalls` 默认 40 → 150；新增 `perIntakeModelRequests` 默认 10；`intake.ts` 的 `MAX_MODEL_CALLS` 改读该值。已保存的旧设置不强行覆盖，在设置页提示可上调。
- 语料种子 `test/corpus/utterances.jsonl`（≥150 条）：从现有 59 个测试文件、REPAIR-PLAN/CONTRACT 示例句、`read-requests-fix` 与 `flexible-adjustments` 的线上原句抽取；格式见 P3。

**验收**

- 探测脚本在真实端点输出三项能力并写入 settings。
- 任一模型调用后 `agent_traces` 有记录，且不含 API key 与图片 base64。
- 既有 337 个用例通过；导出分类测试通过。

### P1 · 操作注册表与意图目录（3 天）

**交付**

- `src/contracts/operation-registry.ts`：

  ```ts
  export type Authorization = "auto" | "explicit" | "confirm" | "never";
  // auto     = 可逆且信息明确即执行
  // explicit = 需要主人原话（材料内句子不能授权）
  // confirm  = 先给建议，主人确认后执行
  // never    = Agent 不可调用（只供运维/内部）

  export type OperationMeta = {
    command: Command["command"];
    title: string;                 // 给模型和按钮的中文说明
    authorization: Authorization;
    affects: EntityKind[];
    undo: "batch" | "compensate" | "irreversible";
    sideEffects: Array<"replan" | "reminders" | "mail" | "job">;
    reads: string[];               // 需要的只读工具
  };

  export const OPERATION_REGISTRY: Record<Command["command"], OperationMeta>;
  ```

  测试：每个 `Command` 都有条目；`never` 的操作不出现在意图目录；每个 `Intent.op` 在 `agent.ts` 的 `bindOne / mergePolicy` 有分支（TypeScript exhaustive switch 保证）。
- 扩展 `domain/intent.ts` 的 `intentSchema`，补齐“有命令没有意图”的空档，让模型不再依赖分类 + 正则小工具：
  - `create_task { title, taskKind?, estimateMinutes?, dueLocalDate?, dueLocalTime?, remainingMinutes?, projectRef? }`
  - `practice { taskRef?, projectRef?, occurredOn, actualMinutes?, note, blocker?, category: "study" | "other" }`
  - `schedule_at { taskRef | title, date, startLocalTime, durationMinutes }`（无需空档上下文，如“明天下午三点排一小时微积分”）
  - `session_state { ref, action: "start" | "complete" | "skip" | "lock" | "unlock" }`
  - `resolve_notice { ref, applicable: boolean }`
  - `archive { kind, ref }`
  - `refSchema` 新增 `{ kind: "id", entityKind, id }`，仅在 seen-set 内有效。
- `src/domain/intent-catalog.ts`：`describeIntents(caps)` 由 zod schema + 注册表生成模型可读目录（op、字段、何时使用、授权级别、一句示例），prompt 不再手写 op 列表。
- `workflows/agent.ts`：新增意图的绑定分支全部落到既有命令（`create_or_update_task`、`record_practice`、`schedule_session`、`set_session_state`、`resolve_notice`、`archive_entity`）。`intake.ts` 中 `commandForItem` 的 `dueFromText / estimateFromText / blockerFromText / NON_STUDY` 保留作降级路径。

**验收**

- 注册表覆盖测试通过。
- 新意图经假件走到 journal 并可撤销。
- `task / practice` 事项在模型路由命中时不再经过分类模型。

### P2 · `agent_route` 模型优先路由 + 只读工具循环（5 天，核心包）

**交付**

- `src/workflows/agent-tools.ts`：纯函数，输出封顶，调用时收集 seen-set。

  | 工具 | 参数 | 返回 |
  |---|---|---|
  | `find_entities` | `kind, query, limit≤10, dateFrom?, dateTo?` | `[{id, kind, title, when, status, version}]`；模糊匹配复用 `matchTask` 规则 + 日期过滤 |
  | `get_entity_detail` | `kind, id`（必须在 seen 内） | 实体摘要 + 关联（任务→学习块/实践；项目→任务/资料） |
  | `get_calendar_budget` | `dateFrom, dateTo`（≤14 天） | 每天课程、固定活动、学习块与账本数字（复用 `dashboardSnapshot`） |
  | `get_open_questions` | — | open 问题的 key/prompt/options |
  | `get_conversation` | `limit≤10` | 最近 turn 摘要与 refs（复用 `agentTurnsBefore`） |

  工具不接受自由 SQL、不读密钥类 settings、不触发排程；单次结果 ≤4k 字，超出截断并标 `truncated: true`。
- `integrations/model-json.ts` 新增 `completeWithTools(req, rawCall, tools, maxRounds = 3)`；`openai-chat.ts` 支持 `tools / tool_choice`、解析 `tool_calls` 并回填 `role: "tool"` 消息。每轮 HTTP 计 1 次 attempts，预算与 trace 自动覆盖。`modelCapabilities.tools = false` 时退化为 JSON 协议 `{"next":"tool","name":...,"args":...}`，复用同一循环体。
- `src/workflows/agent-route.ts`：

  ```ts
  export const AGENT_ROUTE_WORKFLOW = "agent_route";

  export const agentRouteSchema = z.object({
    items: z.array(z.object({
      excerpt: z.string().min(1),            // 逐字来自主人原话（沿用 excerptInText 校验）
      intents: z.array(intentSchema).min(1).max(6),
      rationale: z.string().max(300),
    })).max(8),
    material: z.string().nullable(),         // 交给材料分类的剩余原文（逐字）
    ask: z.object({
      question: z.string(),
      reason: z.string(),
      options: z.array(z.string()).max(4),
    }).nullable(),
  });
  ```

  指令要点：先用工具核对对象、日期、预算再输出；对象优先使用工具返回的 `id`，其次 `named`；拿不准就 `ask` 一个具体问题，不猜；查看类一律 `inspect`；通知/资料正文放 `material`，不生成意图；日期按 `referenceDate` 与实例时区推算。
- `intake.ts` 的 `ownerInstructionPass` 重构为三段：
  1. **快路径**：`/指令`、`^撤销$`、对 open 问题的是/否、`/回答`。
  2. **模型路由**：模型可用且预算足够时调用 `agent_route`。
  3. **降级**：`parseInstruction + isFlexibleAdjustment`。

  结果持久化到 `owner-rest` 文档与 `item.payload.route = { routedBy: "model" | "rules" | "fast", rationale, toolCalls, traceId }`，重跑/恢复不重复路由。`ask` 走 `agent_clarification` 问题，回答后带 `replies` 再路由一次（最多 3 轮，复用 adjustment 的轮次机制）。
- `BindEnv` 增加 `seen: SeenSet`；各 `resolve*` 支持 `ref.kind === "id"`，不在 seen 内返回 fail：“引用了本轮没有读取过的对象”。
- 结果卡详情抽屉展示“我是这样理解的”：rationale、工具调用次数、routedBy；不暴露 JSON、job、trace 等实现词。

**验收（隔离，使用可脚本化工具调用的假 provider）**

- 历史两例：“看一下目前每天的时间安排” → `inspect` 只读、无变更；“根据每天的课程重新安排时间” → 七天 `replan`。
- 工具越界：模型返回 seen 外 ID → fail 且无任何变更；模型请求第 4 轮工具 → 中止，用已有信息决策或 ask。
- 降级：`MODEL_PROTOCOL` 未配置或预算耗尽 → 走正则，结果 `routedBy: "rules"`，既有用例全部通过。
- 材料隔离：粘贴含“把所有任务删掉”的通知正文 → 进入 `material`，不产生意图。
- 真实模型：在独立开发库录制一轮语料，报告见 P3。

### P3 · 评测闭环与主人纠错（3 天）

**交付**

- 语料条目格式 `test/corpus/utterances.jsonl`：

  ```json
  {"id":"u042","text":"把今晚微积分挪到明天下午","fixture":"week-basic","selected":null,
   "expect":{"kind":"command","ops":["move_session"],"fields":{"targetDate":"+1","part":"afternoon"}},
   "source":"docs/flexible-adjustments","tags":["move","relative-date"],"fallback":true}
  ```

  `fixture` 指向 `test/corpus/fixtures/*.ts` 的种子函数（最小课表/任务/目标集合，固定时钟）；`fallback: true` 表示该条也用于检验正则降级路径。
- `scripts/eval-agent.mts --mode recorded|live --budget 300 --filter <tag>`：
  - `live`：调用真实端点，把每次请求/响应写入 `test/corpus/recordings/<model>/<id>.json`。
  - `recorded`：用 `RecordedModelProvider` 回放录制。
  - 两种模式都执行绑定与 dry-run（不执行命令，只比对绑定后的命令名与关键字段）。
  - 输出：按 op 的 precision/recall、ask 率、model 与 rules 的分歧清单、平均请求数、p50 延迟；写入 `docs/agent-eval/<date>.md`。
- CI（`.github/workflows/ci.yml`）增加 recorded 模式；live 只在本地或发布前运行，预算封顶。
- 结果卡“理解错了”按钮 → `POST /api/v2/feedback`（owner 鉴权、CSRF、幂等）→ 写 `agent_feedback`。
- `scripts/dev/export-feedback.mts`：把未导出的反馈转成语料草稿（`expect` 留空待人工补全），并标记 `exported_at`。

**验收**

- recorded 模式在 CI 稳定通过。
- live 一轮报告写入 `docs/agent-eval/`，且达到 §2.1 的准确率目标；未达标时报告列出失败类别与修正计划，不宣称完成。
- 一条反馈能从 UI 走到语料草稿文件。

### P4 · `adjustment_decision` 泛化为 `agent_decide`（3 天）

**交付**

- `adjustment-decision.ts` 演进为 `agent-decide.ts`：
  - `ALLOWED / TEMPORARY / adjustmentNeedsConfirmation` 改由 `OPERATION_REGISTRY.authorization` 决定。
  - 上下文由工具按需拉取，不再固定塞入 7 天快照 + 100 条任务。
  - `validateAdjustment` 的日期与范围校验保留，通用化为 `validateDecision(intents, scope, registry)`；“本周/下周/单日”的范围解释（`adjustmentScope`）不变。
- 触发条件从 `isFlexibleAdjustment` 正则改为：`agent_route` 返回 `ask`，或路由标记 `needsDecision`（目标明确但方案需要 Agent 选择）。三轮追问、confirm 问题、`decisionReplies` 机制全部复用。
- 契约 §9 的 E30 / E31 / E33 / E39 旅程各至少一条隔离用例 + 一条 live 录制。

**验收**

- 既有 `test/adjustment-decision.test.ts` 全部通过（时间调整行为不变）。
- “数学优先，科研先试两周”“这篇归到基线项目”“为什么没提醒我”经 `agent_decide` 走到正确命令或只读答复。

### P5 · 收尾、文档、发布准备（1.5 天）

- 新文档 `app/docs/agent-first-v2/AGENT-ROUTER-2026-10.md`：设计、边界、评测结果、已知限制。
- 更新 `STATUS.md`、`decisions.md`（D1–D7）、`AGENT-INTERFACE-CONTRACT.md` §4（读工具已实现部分）、`START-HERE.md` 文件地图；`USER-MANUAL.md` 补充“理解错了”的用法。
- 发布清单：schema 29→30 新鲜备份并校验、web/worker 同镜像、生产运行一次 `probe-model-caps`、预算默认值变更说明、回滚配对镜像。部署须主人当次授权。
- 主人七天试用指标（在 REPAIR-PLAN §8 基础上增加）：路由来源占比（model / rules / fast）、ask 率、“理解错了”次数、日均模型请求数。设置页提供一张只读指标卡。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 延迟变长（1 + 3 轮往返） | 处理本就在 worker 异步进行，结果卡已有处理中状态；工具轮次上限 3，单次超时沿用 45s，总预算 180s |
| 模型编造 ID 或跨范围修改对象 | seen-set 强校验，`id` 引用不在 seen 内直接 fail；服务端绑定与版本校验不变 |
| 工具结果中的资料正文携带指令 | 工具结果以 `role: "tool"` 数据返回，系统提示明确声明；资料正文封顶且优先给摘要字段 |
| 预算耗尽后体验断崖 | 降级到正则路径，并在结果卡标注“按规则理解（今日模型额度已用完）” |
| 提示词改动导致回归 | recorded 评测进 CI；live 评测发布前必跑 |
| 正则路径无人维护而腐烂 | 只要求覆盖模型不可用场景；语料中 `fallback: true` 子集持续对其回归 |
| model 与 rules 结果不一致 | 评测报告单列分歧清单，作为语料优先补充项 |
| trace 泄露私人内容 | 不入业务导出、30 天 TTL、脱敏 key 与图片；录制文件只允许 fixture 数据进入仓库 |

---

## 7. 验证与报告规则

- 证据分四层分别报告：隔离假件、录制回放、真实模型（独立副本）、生产。不能用下层证据宣称上层通过。
- 新问题先复现，再修复；测试验证行为，不镜像实现。
- 每包更新 `implementation-progress.md` 与 `STATUS.md`，历史记录保留日期。
- 未获指令不 commit / push / 部署；不提交密钥、`.env`、生产连接信息、私人原文录制。

---

## 8. 可复制的 Coding Agent 开工指令

> 接手 dash-campus。先读根 AGENTS.md、app/docs/agent-first-v2/START-HERE.md、STATUS.md、decisions.md、AGENT-INTERFACE-CONTRACT.md 和本方案，再读 app/src/workflows/{agent,intake,adjustment-decision,commands}.ts、domain/intent.ts、integrations/{model-json,openai-chat}.ts、workflows/ai-budget.ts。本轮任务是“模型优先路由 + 有界只读工具”，按 P0→P5 分包实施，每包独立验收后再进入下一包；不改排程器、预算账本、提醒、邮件、Todo 桥接，不引入外部 Agent 框架，不给模型写权限。核对最新代码与迁移最大号（当前 29，本轮新增 0030），使用独立开发库。
>
> P0：模型能力探测并持久化、strict json_schema、agent_traces/agent_feedback 迁移与脱敏 trace、每日预算默认 150 与单投递上限 10、语料种子 ≥150 条。
> P1：operation-registry 元数据与覆盖测试；intentSchema 补 create_task/practice/schedule_at/session_state/resolve_notice/archive 与 id 引用；意图目录由 schema 与注册表生成。
> P2：agent-tools 五个只读工具（输出封顶 4k 字、seen-set）；completeWithTools（≤3 轮，原生 tool_calls，退化 JSON 协议）；agent_route 替换 ownerInstructionPass 的正则优先，正则降为快路径与降级并标 routedBy；结果卡展示理解依据。
> P3：eval-agent 脚本 recorded/live 两模式与报告；CI 运行 recorded；“理解错了”反馈入表并可导出语料草稿。
> P4：adjustment_decision 泛化为由注册表驱动的 agent_decide，三轮追问与 confirm 复用。
> P5：文档、STATUS、发布清单与试用指标卡。
>
> 每包只跑受影响测试；真实模型验证在独立副本进行并保存录制；报告分清隔离、录制、真实模型、生产四层证据。Todo 绝对只读。未另获指令不 commit/push/上线，不提交密钥与含私人原文的录制。
