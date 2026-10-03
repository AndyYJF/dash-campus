# Agent-first V2 实施进度

本页按阶段记录事实、缺口和下一步。开工指令见 [CODING-AGENT.md](./CODING-AGENT.md)，完整契约见 [MASTER-PLAN.md](./MASTER-PLAN.md)。每条结论注明验证方式；无证据的能力标为缺口。

## P3 课表、生活预算与学习行动闭环（已完成，2026-10-03）

### 交付

- 迁移 `0019_planning_v2.sql`：planning_preferences（模板起始 tentative：工作日 08:00–22:00、周末 09:00–22:00、三餐、通勤 15、日上限 180、最小块 25、缓冲 20%）+ plan_sessions（唯一排程来源）；schema 19；两表进导出白名单。
- 确定性预算（`domain/budget.ts` 纯函数）：W = A − (F ∪ L)，C_day=min(W×(1−buffer), 日上限)；futureBudget/futureCapacity 按 §6.1 公式，buffer 只在各自范围应用一次。
- 确定性排程（`domain/scheduler.ts` 纯函数）：截止优先→高优→创建时间；块 25–90、间隔 10 分钟、每项最多 3 个未来块；不可行给 deadline_unfeasible/insufficient_capacity/unknown_requirement，不顺延截止。
- 重排（`workflows/plan.ts` rebuildPlan）：supersede 旧未来块 + 新块 + journal（plan_sessions batch）单事务；课表 upsert 后自动触发有限重排。
- 端点：GET /api/v2/dashboard、/api/v2/week、/api/v2/direction（同一 snapshotRevision，GET 纯读取）；POST /api/v2/sessions/:id/{start,complete,skip,lock}（幂等+版本）；POST /api/v2/preferences/confirm（一句话确认模板）。
- 页面：/today 换 V2（课程占用/预算账本/学习块操作/待答/最近变化）、新增 /week（7 天账本+未排原因+确认按钮）、/direction（目标/实践/诚实声明）；导航加“本周”“方向”。

### 验证证据

- 新增 `test/pages-v2.test.ts` 6 项：课表导入后 dashboard 课程占用 100 分钟+C_day=180(tentative)；2h 任务 90+30 落入合法时段避开课程；week 与 dashboard 同 snapshotRevision、weekBudget=1260；start/complete 只完成块不完成任务；600 分钟任务截止不可行进 unscheduled 且截止不顺延；direction 诚实证据状态。
- 全套 **176/176 通过**，typecheck/lint/build 无错。

### 本阶段决策（最小一致选择）

- 通勤只加在课程投影事件上，手工固定事件不加。
- B_day 最小口径：完成块按计划分钟暂扣（estimated）+ 当日实践已记录分钟；尚无 focus 计时器，无双计来源。
- 未排原因存在最近一次 plan_sessions batch 的 reason JSON，week 端点读取，保证 snapshot 一致。
- 旧 TodayView（v1 任务清单）保留文件但 /today 已切 V2；旧 /plan 等页面不动。

### 已知限制

- focus_sessions（计时器）未做，无双计合并场景；“记录 40 分钟不重复计时”在 P4/P5 有计时器后补验收。
- 实践记录与学习块尚未自动关联（预算账本分开累计）。

## P2 执行策略、实体关联与可撤销变更（已完成，2026-10-03）

### 交付

- 迁移 `0018_course_commands.sql`：semesters / course_sets / courses / course_meetings / course_meeting_projections / entity_source_links / agent_action_batches(+changes) / practice_entries；`EXPECTED_SCHEMA_VERSION=18`；9 张新表全部进 full_json 导出白名单。
- 命令白名单（`contracts/commands.ts`）：upsert_course_set、record_practice、create_or_update_task；Zod 校验 + 服务端解析目标，模型不碰任意 ID。
- 命令执行器（`workflows/commands.ts`）：单 IMMEDIATE 事务内完成领域写入 + journal；同学期整套替换（旧 set supersede + 投影删除）进同一 bundle。
- 撤销（`workflows/undo.ts` + `POST /api/v2/actions/:batchId/undo`）：粒度=batch；逐项校验当前版本==afterVersion，冲突整体不动返回 409；已撤销批次重复撤销 409；版本不倒退。
- 重试/取消：`POST /api/v2/intakes/:id/retry`（只删失败占位重跑分类，不重放已成功 effects）、`POST /api/v2/intakes/:id/cancel`（取消未应用部分，保留已应用结果与撤销入口）。
- intake 管线第三阶段：ready 事项自动经命令落领域——课表→课程语义模型+fixed_events 投影+来源关联；practice→practice_entries（分钟从引用逐字解析，user_reported）；task→tasks；notice/note 只留事实不行动。

### 验证证据

- 新增 `test/commands-course-v2.test.ts` + `test/commands-items-v2.test.ts` 共 8 项：课表落模型+投影+来源关联、undo 回滚、重复 undo 409、实体后续修改后 undo 409 且不覆盖、retry 只重试失败分支、practice 分钟 user_reported、task 落库、cancel 不产生实践记录。
- 全套 **170/170 通过**，typecheck/lint 无错。

### 本阶段决策（最小一致选择）

- entity_revisions 不单独建表：agent_action_changes 的 before/after 已覆盖快照职责（§5.1 说“尚无专用 history 的实体”才需要）。
- 学期冲突替换：同学期已有 active course_set 时整套替换并进同一 journal bundle（可一并撤销）；与旧 v1 import 的 fixed_events 不交叉管理。
- 固定事件去重沿用 v1 identicalRule：命中已有事件只挂投影不新建，undo 只删自己创建的。
- P1 测试断言 ready → applied 是契约演进：可行动事项现在推进到 applied。

### 已知限制

- create_or_update_task 目前只走 create 路径（intake 来源）；owner 字段冲突提问在后续阶段。
- 撤销 UI 入口未做（API 已通）；/today 等页面还未展示课程（P3）。

### 部署记录（切片1，2026-10-03）

- 本地 verifyCommand 全绿（170/170 + typecheck + lint + build）；commit `5cc9844`，CI success。
- 部署前磁盘治理：删除 22 个旧 dash release/rollback 镜像 + builder prune，/ 空闲 242MiB → 4.8GiB（不动其他服务、不全局 prune）。
- 流程：停 bridge timer/service → 停 web/worker → 备份（schema 16 快照 sha256 ef92f997）→ codeload 源码包覆盖 → build → migrate（0017、0018）→ up → 重启 bridge timer。
- 线上验证：`https://dash.fei.cx/api/v1/health` 返回 schemaVersion **18**；`scripts/dev/p2-online-smoke.sh` 在 VPS 实测：混合投递 → 缺首周问 1 个问题 → 回答「第5周」→ completed，semester(2026-08-31)/course/投影/fixed_event/practice(30分钟,user_reported)/2个batch applied 全部落库；`p2-online-undo.sh` 撤销两个 batch 均 200，领域数据回滚、journal 留 undone 痕。smoke 数据已清理。
- 运维发现：备份脚本在 worker 停机后 ~20 秒内会因心跳未过期拒绝，等 25 秒重试即可；ops 容器 entrypoint 是 bash，一次性命令要用 `ops -c "..."`。

## P1 统一接收、证据和主动问答（已完成，2026-10-03）

### 交付

- 迁移 `0017_intake_clarify.sql`：intakes / extracted_documents / intake_items / clarification_questions(+answers)；同一缺口仅 1 个 open 问题由部分唯一索引保证；`EXPECTED_SCHEMA_VERSION=17`；5 张新表已加入 full_json 导出白名单。
- 契约 `src/contracts/intake.ts`；仓储 `src/repositories/intakes.ts`、`questions.ts`；管线 `src/workflows/intake.ts`；job 类型 `intake_process` 已注册进 worker runner。
- API：`POST/GET /api/v2/intakes(/:id)`、`GET /api/v2/questions`、`POST /api/v2/questions/:id/answers`（幂等 + expectedVersion）。
- UI：`UniversalIntake` 挂入 AppShell 全局外壳；提交→轮询状态→事项结果→问题卡回答。

### 验证证据

- 自动测试：新增 `test/intake-v2.test.ts` 8 项（混合拆分、共享问题、不可解析回答 422、过时答案 409、回答后恢复且不重复调模型、幂等重放/冲突、模型失败原文保留、GET 不暴露实现细节）；全套 **162/162 通过**，typecheck、lint、build 通过。
- 真实端到端（`scripts/dev/p1-e2e-evidence.sh`，真实 next dev + worker + 真实模型 gemini-3.8-flash-high）：混合材料拆出课表+实践+资料 3 个事项 → 课表缺首周只问 1 个问题 → 回答「第5周」→ 恢复后课表候选 firstMonday=2026-08-31（正确推算）、16 次课时 → intake completed。
- 证据校验真实生效：模型两次返回非逐字 excerpt（字段名漂移/文本被搞坏），被 excerpt 校验拒绝并按原始资料保留——A10 路径在真实模型下验证过。

### 本阶段决策（最小一致选择）

- 课表锚点回答支持「第N周」（以回答提交日本周周一回推）与显式日期（归一到所在周周一）；其他自由文本 422 不吞掉。
- 模型不可用/分类失败：原文保留为 failed note 事项，intake 落 failed/partially_applied；显式重试端点留到 P2 与命令层一起做。
- excerpt 校验容忍空白差异（折行/多空格），其余必须逐字。
- 已提交 id 存本机 localStorage 实现“重新打开可看到同一条记录”；列表端点待 P2+。

### 已知限制（不掩盖）

- P1 只生成核对后的事实/候选：课表候选尚未写入课程模型/固定事件（P2 `upsert_course_set`），今天/本周页面还不受 intake 结果驱动（P3）。
- 浏览器端到端（真实点击）未做，本轮证据为 HTTP 级真实服务器 + 真实模型；A20 窄屏验收在后续阶段。
- `POST /api/v2/intakes/:id/retry` 与 cancel 端点未实现（§8 已列，P2 补）。

### 下一步

进入 P2：policy 白名单 + entity_source_links + journal/revision + 原子 bundle/undo；课表候选经命令层写入课程模型与投影；practice/task/notice 事项落领域记录。

## P0 基线、运行边界与迁移准备（已完成，2026-10-03）

### 已核对事实（2026-10-03）

| 项 | 事实 | 验证方式 |
|---|---|---|
| 工作仓库 | `~/pi/Dash-campus`，main @ `7f1e85c`（与 origin/main 一致），工作区干净 | `git pull --ff-only` + `git status` |
| 测试基线 | `npm test` 154/154 通过 | 本机实际运行 |
| 迁移最大编号 | 17（P1 新增 `0017_intake_clarify.sql`），`EXPECTED_SCHEMA_VERSION = 17` | `migrations/` 与 `src/repositories/db.ts` |
| 旧本地开发库 | `app/data/dash-campus.db` 停留 schema 10，无生产意义；不迁移、不重建，留作历史 | 只读打开核对版本 |
| V2 独立开发库 | `app/data/v2/dash-campus.db`，从零跑全迁移，schema 17、deployment_epoch 0；由 `scripts/dev/v2-dev-db.sh` 创建 | 实际执行迁移并核对 |
| 模型文本能力 | `gemini-3.8-flash-high`（openai-chat，`api.fei.cx`）文本请求 HTTP 200 | `scripts/dev/probe-model-vision.mjs` 实测 |
| 模型图片能力 | **支持**：同一端点接受 `image_url`（data URL）消息并正确描述 1×1 测试图颜色 | 同一脚本实测，非从文档推断 |

### 关键结论

- 图片输入走已配置模型的图片消息扩展即可，**P4 不需要本地 OCR 容器**；VPS 磁盘压力因此减轻。A14 的真实截图/扫描 PDF 验收仍在 P4 执行。
- 已配置的 `.env` 含模型/搜索/SMTP 真实密钥，只在本地与服务器，不入库。
- 本机不存在旧 Todo 数据库、附件或服务（旧 Todo 只在生产服务器）；本机开发不存在误写 Todo 的路径。生产侧只读保护清单沿用 [legacy-compatibility-2026-10-03.md](../legacy-compatibility-2026-10-03.md) §3–5：只读连接/快照、禁止 UPDATE/DELETE/DDL/VACUUM、桥接只 GET。

### 缺口 / 待办

- VPS 磁盘余量未在本次复核（主机信息不入库，本机无 SSH 配置）；最近观测 2026-10-03 约 208 MiB（[STATUS](../STATUS.md) §3）。上线/加 OCR 前的容量方案已定：离机构建、仅清 Dash 旧构建缓存、禁止全局 `docker prune`、预留 ≥1 GiB。执行时需主人提供服务器访问方式。
- 真实邮件到达仍未验收（沿用 STATUS §4，非本轮阻塞项）。

