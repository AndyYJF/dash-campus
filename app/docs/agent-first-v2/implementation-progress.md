# Agent-first V2 实施进度

本页按阶段记录事实、缺口和下一步。开工指令见 [CODING-AGENT.md](./CODING-AGENT.md)，完整契约见 [MASTER-PLAN.md](./MASTER-PLAN.md)。每条结论注明验证方式；无证据的能力标为缺口。

## P4 文件理解与只读来源接入（部分完成，2026-10-03）

### 交付

- 迁移 `0020_attachments.sql`：intake_blobs（hash 去重，二进制原件，列入导出排除）+ intake_attachments（同 intake/hash 唯一）；`0021_extend_item_kind.sql`：intake_items 重建，kind 增加 `ics`。schema 21。
- POST /api/v2/intakes 支持 multipart：text/urls/files/referenceDate；限额 10 文件 / 单件 10MiB / 共 30MiB（413 报尺寸、422 报数量）；multipart 幂等摘要用规范化字段（boundary 随机不能直接比对）。
- ICS 子集（`domain/ics.ts` 确定性解析，一次性 VEVENT；RRULE 跳过计数）→ 新白名单命令 `import_fixed_events` 落固定事件 + journal，可 undo。
- CSV/TXT/MD 附件并入分类文本；图片附件走模型 vision（`buildMessages` 支持 image_url parts，端点已实测可用）；URL 最多 2 个，worker 内抓取（data:/http(s)，10s 超时、1MiB 上限、去标签），抓过一次不重抓。
- PDF/XLSX 明确失败：原文保留为失败事项，提示可复制文字投递（不静默丢）。

### 验证证据

- 新增 `test/intake-files-v2.test.ts` 6 项：超限 413/422；ICS 入库+undo 清空；CSV 两份不同日期投递各自落实践记录（不按文字 hash 去重）且 blob 只存一份；图片触发 1 次 vision；data: URL 提取入证据；PDF 明确失败含“PDF/不支持”提示。
- 全套 **183/183 通过**，typecheck/lint/build 无错。

### 本阶段决策（最小一致选择）

- PDF/扫描件/XLSX 需要解析库（unpdf/exceljs 属新 npm 依赖），本阶段先明确失败；是否加依赖待主人批准后在后续切片补。
- vision 分类产物不做 excerpt 逐字校验（无原文可对），证据即图片本身；文本类仍强制逐字。
- 校园/Todo 来源适配器沿用 v1 桥接（只读），V2 未新增写路径；Todo 写操作拒绝由既有只读约束覆盖。

### 已知限制

- ICS 只支持一次性事件（RRULE 跳过计数，不半解析）。
- 重建后“不灌回全部历史”沿用既有桥接游标语义，V2 未新增回灌路径。

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

### 部署记录（切片2，2026-10-03）

- 本地全绿（176→177/177）；commit `61a5149`→`085e446`，CI success ×3。
- 线上 schemaVersion **19**；三页面 /today /week /direction 均 200。
- 线上实测：dashboard 模板容量 cDay=180(tentative)、weekBudget=1260；投「明天前复习…大约两小时」→ 任务带估时 120 落库 → rebuild placed=2（90+30 块）→ dashboard 出现学习块；undo + rebuild 清理完毕（planned sessions 0、smoke 任务 0）。
- 生产既有 8 个无估时任务诚实报 unknown_requirement，未被硬排。
- 线上发现并修复 2 个缺陷：任务估时/截止未从原文解析（补「小时/分钟/今天明天后天」确定性解析，中文数字「两」）；undo 任务时 plan_sessions FK 阻止删除（任务撤销连带清理其学习块）。

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


### P4 部署记录（2026-10-03）

- commit `9b1ae01`（P4 主体）+ `5e9a92d`（0021 迁移修复），CI run 37118703985 / 37119127750 均绿。
- 生产部署：备份 `dash-campus-backup-20261003-111818`，迁移 0020+0021 应用后 schema 21，桥接 timer 已重启。
- **0021 迁移事故与修复**：首版用 `PRAGMA foreign_keys=OFF` 重建表，但迁移在单事务内运行该 PRAGMA 无效，DROP TABLE 触发即时 FK 检查失败回滚（schema 停在 19）。改为方案 B：断 `clarification_questions.item_id` 引用 → 重建 → 恢复。已用带数据的 dev 库验证无损。
- 线上冒烟（p4-online-smoke.sh）：multipart 上传 ICS → intake completed → fixed_events 落库 `[smoke] ICS 讲座 2026-10-09 14:00` → undo 清理成功。健康检查 schemaVersion 21。

## P5 方向证据、每周主动维护与邮件（2026-10-03）

### 交付

- 方向页候选：`directionSnapshot` 接入 v1 candidates 表（status=proposed，最多 3 个，含 deliverable/fitReason/evidenceStatus/canonicalUrl），前端展示带来源链接。
- 周事实扩展：`weekFacts` 新增 planSessions（计划/完成/跳过计数）+ practice（次数/总分钟），每周回顾邮件引用真实记录（"实践记录 N 次共 M 分钟"、"学习块：计划/完成/跳过"）。
- 每天有限重排：新 job 类型 `plan_maintenance`，scheduleDigests 按本地日期 dedupe（同日只排一次、错过不补），handler 调 rebuildPlan。

### 验证证据

- 新增 `test/direction-maintenance-v2.test.ts` 4 项：周事实 V2 统计、周邮件含实践/学习块、候选 ≤3 带证据状态、maintenance 同日不重复且执行完成。
- 全套 **187/187 通过**，typecheck/lint/build 无错。

### 本阶段决策

- 每周有限探索沿用 v1 exploration topics 机制（已有调度+预算），V2 不重复建设。
- 邮件复用 v1 投递（deliveries accepted/unknown 语义、安静时段、不自动重发），V2 只扩展内容不碰投递机制。
- `plan_maintenance` 无条件排队（不受 digest 邮件开关影响）——重排是系统维护不是通知。

### 已知限制

- 方向候选来源是 v1 探索系统的 proposed 候选，V2 未新增"方向推荐"模型调用（§7 不替用户选方向）。
- focus_sessions（计时）仍未实现，P3 已记录为差距。

### P5 部署记录（2026-10-03）

- commit `b43f529`，CI run 37120278993 绿；备份 `dash-campus-backup-20261003-113936`，无新迁移（schema 21）。
- 线上验证：plan_maintenance job 已排队执行（done, plan:rebuilt）；/api/v2/direction 返回 3 个真实 proposed candidates（含 deliverable/来源）；健康检查 schemaVersion 21。

## P6 切换、恢复、旧界面退休与交付（2026-10-03）

### 交付

- A16 SSRF 主动防护（私网/环回/链路本地拒绝，重定向逐跳校验）。
- A03 `apply_event_exception` 命令 + `course_event_exceptions`（0022，schema 22），eventsForDay 排除例外，可 undo。
- A09/A17 验收测试（锁定块保留、恶意指令只作原文）。
- A18 `restore-drill.ts` 恢复演练脚本（WAL checkpoint→隔离拷贝→blob hash 校验→hold 列验证），本地 dev 库演练通过。
- `acceptance-map.md`：A01–A22 逐项映射（17 ✅ / 5 🟡 带差距说明与保留方案）。
- 旧界面退休第一步：导航移除 v1「计划」页（/plan 路由保留兼容，不进导航）。

### 验证证据

- 新增 `acceptance-v2.test.ts` 4 项；全套 **191/191 通过**，typecheck/lint/build 无错。
- 部署：commit `4fceb10`+`ccf15ab`（CI 37120… failure 为 lint require，已修并复绿）；备份 `dash-campus-backup-20261003-115952`；线上 schemaVersion 22。

### 保留差距（验收映射 §已知限制）

focus 计时器未实现、PDF/XLSX 待依赖批准、vision 无坐标、A20 需人工走查、A21 引导组未做、域名→私网 DNS 防护未做。

## P6 补强：focus 计时 / archive_entity / 排程单一源（2026-10-03，judge 复审后）

### 交付

- **focus_sessions 计时**（0023，schema 23）：部分唯一索引保证最多 1 个进行中；POST /api/v2/focus（start，已有则 409）、POST /api/v2/focus/:id/stop（版本校验；>4h 需 confirm=true；同日手动汇报分钟差 ≤10min 自动合并不双计——A08 完整闭环）；今天页计时卡片（开始/停止）。
- **archive_entity 命令**（白名单第 7 个）：task/goal 软删 archived_at、course_set 转 superseded，journal+undo 恢复。
- **plan_sessions 唯一排程事实源**：0023 把 v1 tasks.scheduled_start/end 一次性迁入 plan_sessions（locked=1 保留原安排，幂等不重复）；V2 快照链路只读 plan_sessions。
- dashboard snapshot 加 focus 字段。

### 验证证据

- 新增 `focus-v2.test.ts` 4 项（max 1 进行中、stop 落 timer 分钟、A08 合并标注不翻倍、>4h 确认）；acceptance-v2 加 archive undo 测试。全套 **196/196 通过**。
- retry/cancel 端点（judge 追问项）自 P2 已存在：POST /api/v2/intakes/:id/retry、/cancel（`src/app/api/v2/intakes/[id]/retry|cancel/route.ts` + commands-items-v2 测试覆盖）。

### 覆盖事故记录

- 误将 v1 `repositories/focus.ts`（周重点）覆盖为计时仓储，已用 git show 恢复并改名 `focus-timer.ts`。教训：写新文件前先 grep 同名。

### P6 补强部署记录（2026-10-03）

- commit `dc9a922`，CI 绿；备份 `dash-campus-backup-20261003-121822`；迁移 0023 应用后 schema 23。
- 线上验证：生产无旧排程残留（tasks.scheduled_start 全 NULL，迁移无对象）；focus 冒烟 start 201 / 重复 start 409 / stop 200 落 1 分钟 timer 实践，smoke 数据已清理；健康检查 schemaVersion 23。

## P4 补全：PDF 文本层提取（2026-10-03，依赖已获批准）

- 新增依赖 `unpdf`（纯 JS，无原生依赖）：PDF 走文本层提取→进入分类；扫描件/解析失败明确提示「请截图投递或复制文字」，原文保留。
- 测试：手写最小合法 PDF（无 xref，pdfjs recovery 解析）断言文本层内容落 practice 项；假 PDF 断言失败路径。坑：模板字符串里少一个 `>` 会让 Page 字典未闭合，报 "Page dictionary kid reference points to wrong type"。
- 全套 197/197 + typecheck/lint/build 绿。

## UI 修复（2026-10-04，commit 6c4f6e1）

- **根因**：v2.module.css 误用不存在的 var(--paper/--border/--accent/--muted)，样式全失效；intake.module.css 靠回退值硬撑（暗色下白框）。
- **修复**：全部换 globals.css 的 --color-* token；补齐 btn/btnPrimary/btnGhost；今天页 4 格数字块、计时绿色脉冲点；本周页今日行高亮；方向页候选卡片化；命令中文标签补全。
- **验证**：本地生产模式 + Edge CDP 截图自查（暗色/亮色/390px/桌面），无横溢出；197/197 + typecheck/lint/build 绿；已部署线上（schema 23 不变）。
- **工具**：`~/pi/tmp/cdp-shot.mjs`（Edge --remote-debugging-port=9222 + Node 原生 WebSocket 截图，本机无 Chrome）。
- A20 剩余：键盘 Tab 走查（用户）。
