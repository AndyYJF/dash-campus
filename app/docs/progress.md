# 进度记录

## T0 项目与依赖 —— 已完成（2026-09-28）

**实际实现的可见行为**

- `Dash-campus/app` 脚手架可启动：Next.js 16 + TS + App Router + src/ 目录 + lockfile。
- `GET /api/v1/health`：返回 db 状态与 schemaVersion；数据库不可用时 503。
- `GET /api/v1/integrations`：返回 model/search/smtp 三集成状态（configured / not_configured / error），不暴露 secret。
- `/` 307 跳转 `/today`；`/today` 渲染 AppShell + 集成状态（未配置时显示"未配置 + 去设置"）。
- 数据库：better-sqlite3 本地 WAL、外键、busy_timeout 5000；`scripts/migrate.sh` 迁移命令幂等，重复执行提示已是最新。

**关键规则/API/数据变化**

- 配置名全部按计划第 3 节固定，`.env.example` 占位；`src/config.ts` Zod schema 校验，`APP_TIMEZONE` 默认 Asia/Shanghai。
- `src/contracts/model.ts`（ModelProvider 窄接口）、`src/contracts/search.ts`（Search/Extract）、`src/integrations/fake-model-provider.ts`。
- 迁移骨架 `migrations/0001_schema_version.sql`；版本探测容忍空库（无表返回 null）。

**验证（均为本地真实执行）**

- `npm run typecheck`、`npm run lint`、`npm run build` 全部通过。
- 生产模式启动后 curl 实测：health 返回 `{"ok":true,"schemaVersion":1}`；integrations 三项均 `not_configured`；`/today` 200；`/` 307。缺模型/SMTP/search 时基础页面可用且正确显示未配置。
- 注意：此前用 `taskkill //IM node.exe` 停服务误杀所有 node 进程（含 agent 自身），后续停服务改用按端口查 PID 精确结束。

**未完成 / 受限**

- 真实模型/搜索/SMTP 适配器未接入（T5/T3），T0 只提供 fake 与接口骨架。
- 未做浏览器实测（T2 起用 Playwright）；亮暗主题仅定义变量未做截图验证。
- git 提交未做（按规则不代用户提交）；lockfile 已在磁盘上。

**下一项**：T1 数据与身份 —— owner/sessions migrations、登录退出、版本与幂等共用组件、目标项目任务基础。无需额外输入即可开工。

## T1 数据与身份 —— 已完成（2026-09-28）

**实际实现的可见行为**

- 迁移 0002/0003：owner(id=1 CHECK)、sessions（只存 token 摘要 + csrf + 到期）、idempotency_keys 三元组唯一；goals/projects/project_goals/tasks 全字段 CHECK、外键、索引、version、软删除。
- `POST /api/v1/setup`：SETUP_TOKEN 验证 + 创建唯一主人，一次性；重复初始化 409。
- 登录/登出/会话列表/按 id 撤销：`/auth/login|logout|sessions|sessions/:id`；httpOnly + SameSite=Lax cookie，30 天有效。
- 未登录访问任何数据路由 401；变更请求缺 CSRF 头 403。
- 目标/项目/任务 GET/POST/GET:id/PATCH/POST archive：PATCH 需 expectedVersion，版本不匹配 409；创建 POST 要求 Idempotency-Key，同键同体重放返回既有资源，同键异体 409。
- `/setup`、`/login` 页面可完成初始化与登录流程。

**关键规则/API/数据变化**

- 新组件：`src/domain/password.ts`（scrypt）、`src/domain/session.ts`、`src/workflows/auth-guard.ts`、`src/workflows/idempotency.ts`、`src/workflows/http.ts`（统一错误与幂等创建）、`src/repositories/planning.ts`、`src/contracts/planning.ts`（Zod 契约前后端共用）。
- 任务 due 存为三列（due_kind/due_local_date/due_timezone/due_at），映射回三值 Due。

**验证（本地真实执行）**

- `npm test`：11/11 通过（owner 唯一、会话生命周期、409 语义、幂等重放/碰撞、软删除、重启保留数据）。
- `npm run build` 通过。
- `scripts/smoke-t1.sh` HTTP 冒烟 13/13：未登录 401、setup 201/重复 409、登录、缺幂等键 422、幂等重放、异体 409、PATCH 版本冲突 409、缺 CSRF 403、登出 401。

**未完成 / 受限**

- 未做浏览器实测（UI 登录页只做了代码级实现）；CSRF/会话安全未过 Playwright。
- git 提交未做（按规则不代用户提交）。

**下一项**：T2 最小执行闭环 —— 今日、任务 CRUD（前端）、项目详情、日志、成果链接、周视图、提案骨架。无需额外输入即可开工。

## T2 最小执行闭环 —— 已完成（2026-09-28）

**实际实现的可见行为**

- `GET /api/v1/today`：共同 asOf 快照（WeekStatusStrip 全字段：重点/剩余已知/未知/未来容量/缓冲），actions 按 overdue/today/upcoming/this_week 分组最多 6 项，decisions 取 pending 提案，recentLogs 3 条。
- 周视图 `GET /api/v1/planning/week`：整周承诺（含 done）、未知单列、剩余负担、整周/未来容量（可用窗口并集 − 固定事件 ×0.8，过去空闲不计入未来）；周重点 PUT（首建幂等/更新 expectedVersion）/DELETE。
- 日志 POST：clientEntryId 幂等（同 ID 同正文重放，异正文 409），进展/卡点至少一项非空（DB CHECK + Zod 双保险）。
- 成果：文本/链接两类，URL 限 http/https，软删除带版本。
- 提案：`POST /proposals`（T2 支持改期骨架）→ 回顾页 diff → `apply` 原子全量应用（BEGIN IMMEDIATE + 读集版本 + planningRevision 校验），重复 apply 幂等返回既有结果，过时 409；reject/snooze（默认次日展示前重检）。
- 前端：今天页（状态带+双栏+行内完成 pending 语义+QuickLogForm 草稿）、计划页（重点编辑/周负担/改期发起）、项目详情（任务/成果/记录）、回顾页（ProposalDiff + 应用/拒绝/暂缓）。

**关键规则/API/数据变化**

- 迁移 0004（daily_logs/artifacts/weekly_focus/availability_blocks/fixed_events/planning_state）+ 0005（proposal_groups/proposals/proposal_operations）。
- planningRevision：任务排程 PATCH、可用窗口/固定事件写入、周重点变更时递增；排程类提案 apply 校验，纯状态提案不校验（F10）。
- 新组件：`src/domain/time.ts`（Intl 时区）、`src/domain/workload.ts`、`src/repositories/{logs,focus,proposals,proposal-decisions}.ts`、`src/workflows/{apply-proposal,http}.ts`。

**验证**

- `npm test` 21/21：F6（超量≥60+未知单列）、F21（承诺含 done、未来容量 96、缺口 84）、F17（日志幂等/409）、F9（原子性全不写入/重复 apply 幂等）、F10（排程失效/状态不受影响）、无时间数据容量 null。
- `scripts/smoke-t2.sh` HTTP 冒烟 12/12：项目→任务→日志→成果→today 快照→改期提案→apply→幂等重放→过时 409 全链路。
- `npm run build` 通过。

**未完成 / 受限**

- 浏览器人工实测未做（dev 服务器在跑可手验）；Playwright 在 T7 统一做。
- 提案创建仅限改期骨架；AI 生成提案（create_task 组合）在 T6。
- availability/fixed-events 只有 GET/POST，PATCH/DELETE 待 T7 补齐（当前可重建代替修改）。

**下一项**：T3 持久任务与邮件 —— job leases、提醒版本、邮件状态、模板预览、普通邮件。

## T3 持久任务与邮件 —— 已完成（2026-09-28）

**实际实现的可见行为**

- worker 进程（`npm run worker`）：5 秒轮询数据库持久 job；启动先恢复（submitting delivery 一律标 unknown、孤儿 running job 重新排队/落定），SIGINT/SIGTERM 优雅停止。一个实例一个 worker。
- 任务提醒随写入事务同步：due 变化、进入 done/cancelled、从终态重开、归档都递增 reminderRevision 并在同一事务取消未准入提醒、只为未来触发点建新 job；重复打开同一状态幂等无变更（F22）。
- 提醒 job 执行走准入短事务：验证 lease + 任务未结束 + revision 相符 + 未越过截止边界 → delivery queued→submitting（冻结收件人/正文快照）→ SMTP；改期在准入前旧邮件不发，在准入后允许在途（F12）。
- SMTP 未配置时 job 明确失败报 INTEGRATION_UNAVAILABLE，不冒充已发送；AI（模型）全程不参与提醒。
- 新 API：`GET /jobs/:id`、`POST /jobs/:id/cancel`（queued 直接取消/running 记取消请求）、`GET /notifications`（待处理/未来提醒 + 在途旧投递提示 + 投递记录）、`GET /deliveries`、`POST /mail/preview`（不发送）、`POST /mail/test`（仅 MAIL_TO，未配置 503）、`GET/PATCH /settings`（expectedVersion 乐观锁）。
- `/settings` 页面：集成状态、模板配置（前缀/栏目/摘要长度/主题色/隐私模式）、邮件预览（iframe 隔离渲染 HTML + 纯文本）、发送测试邮件、提醒与投递记录（accepted/unknown/failed 文案准确区分）。

**关键规则/API/数据变化**

- 迁移 0006：jobs（dedupe_key UNIQUE、lease_token/lease_until/attempt/generation/cancel_requested、task_id 独立列）、deliveries（request_id UNIQUE、payload 快照、六状态 CHECK）、settings（键唯一带 version）。
- job fencing：领取/续租/提交/终结全部 token+generation 条件更新；lease 60s、15s 续租、外部调用 45s 上限；旧执行者结果被拒（F11）。
- 提醒触发点：date 型截止日当天 09:00（当地），instant 型截止前默认 24h；过去触发点不建 job、进 notifications 待处理；due=none 不建。
- 新组件：`src/contracts/{jobs,mail}.ts`、`src/domain/reminders.ts`、`src/repositories/{jobs,deliveries,settings}.ts`、`src/workflows/{reminders,mail-settings}.ts`、`src/integrations/{mailer,mail-template}.ts`（nodemailer + 固定 HTML 布局 + 纯文本、全转义）、`src/worker/{index,runner,handlers}.ts`。planning.ts 的 create/update/archive 包进事务并挂提醒同步。

**验证（本地真实执行）**

- `npm test` 32/32（新增 11：触发点计算、F22 全组、标题不重建提醒、F11、F12 前半/后半（GatedMailer 卡住发送窗口）、F13 unknown 不自动重发、取消语义、worker 重启恢复、未配置 SMTP）。
- `scripts/smoke-t3.sh` HTTP 冒烟 13/13：未登录 401、建任务出未来提醒、取消 job、预览不发送且为合成示例、未配置 SMTP 503、投递为空、settings 乐观锁 409、worker 启动。
- `npm run typecheck`/`lint`/`build` 通过；smoke-t2 回归 12/12；运行中 dev server `GET /settings` 200。

**未完成 / 受限**

- 真实 SMTP 收件联调未做（无凭证；本地全程 fake mailer），状态记"本地工程完成，真实集成待验证"。
- 浏览器人工检查未做（/settings 仅代码级 + curl 200）；Playwright 仍留 T7。
- 提醒提前量用户自选（任务级 lead 字段）留后续；定期探索/复盘类 job 留 T5/T6；restore/hold（F14）留 T7。
- git 提交未做（按规则不代用户提交）。

**下一项**：T4 收件箱 —— import schema、source revisions、条件 AST、纠正和任务草案。无需额外输入即可开工。

## T4 收件箱 —— 已完成（2026-09-28）

**实际实现的可见行为**

- 迁移 0007：inbox_sources（token 只存摘要）、inbox_messages/(source,external_id) 唯一、inbox_revisions/(message_id,revision_key) 唯一、inbox_decisions、profile_facts/profile_rules、inbox_task_links/(message_id,action_key) 唯一；tasks 增加 source_revision_id。
- `POST /inbox/import`（Bearer 来源 token，只能写入本 source）：同 key 同正文重放、同 key 异正文 409；revisionOrder 决定 current，r1→r2→r1 不回退；不可排序进入 revision_conflict 待主人选择。
- 条件 AST 三值求值（TRUE/FALSE/UNKNOWN）：F1 action、F2 folded 可找回、F3 review 不猜资格。
- 纠正三作用域 `POST /inbox/:id/resolve`：this_revision（仅本条，不改身份，F4）/profile（改身份事实后重评）/rule（人工规则，同优先级冲突 → review）。
- `POST /inbox/:id/create-task`：同 (message, actionKey) 只建一次；来源新修订不覆盖用户任务（F5），只给 sourceChangeDiff 标记。
- UI：`/inbox` 列表分区、`/inbox/[id]` 详情（原文引用、修订差异、三种纠正、建任务）、设置页来源管理与身份事实。

**验证（本地真实执行）**

- `npm test`：inbox.test.ts 10 项（三值求值、F1–F5、修订冲突、token 范围、人工规则、来源变化差异）。
- `scripts/smoke-t4.sh` HTTP 冒烟 18/18。续做时修复：冒烟脚本语法错误；`GET /tasks/:id` 未返回 sourceRevisionId（TaskRow 缺字段）；Windows 下冒烟服务残留锁库（改为共用 `scripts/smoke-lib.sh` 按 winpid + 端口清理）。

**未完成 / 受限**

- 浏览器实测未做；真实群聊导入桥接未接（只有 HTTP import 接口）。

## T0–T4 审查（2026-09-28）

三路只读审查后已修：PATCH schema 补默认值导致清空字段（高）；发送后丢租约重领重复发送、过期租约可续（高）；worker 恢复误标测试邮件；批量领取租约过期；非法 JSON 500；时刻字段不校验 ISO。

**待修清单（未做）**

1. ~~幂等~~（已修，见下）
2. ~~草稿~~（已修）
3. ~~排程提案~~（已修）
4. 容量：固定事件未合并区间重复扣减；hasAnyTimeData 只看周一/周日。
5. 时间：~~QuickLogForm occurredOn 取 UTC 日期；plannedWeek 不校验周一且用浏览器时区~~（修复 1–3 已修）；DST（F19）未实现。
6. T3 UI：unknown 投递显式重发接口/UI 缺；inFlightOldReminders 未渲染；preview 不能选任务。
7. T0/T1：~~启动不检查 schemaVersion~~（T7 已修）；~~setup 非 timing-safe~~（上线时已修）；CSRF 非 timing-safe、登录无限速；关联 ID 不存在 500；~~空 PATCH 不校验版本~~（已修）；updateGoal 空 patch 仍递增；integrations 免鉴权未记录。
8. 其他：~~首页提案 version 写死 1~~、~~snooze 缺 expectedVersion~~（T6 已修）；jobs 接口返回 leaseToken；无 due 无 plannedWeek 的任务被归 upcoming。

## T5 探索与实践 —— 本地工程完成，真实模型/搜索联调通过一次（2026-09-28）

**实际实现的可见行为**

- `/explore`：按需探索（问题、基础与时间、可选关联项目、粘贴资料）；最近运行列表；关注方向（定期开关、每周几/本地时间、立即运行一次）；3 个实践模板（draft）。
- `/explore/[id]`：实际阶段（排队/检索/取回原文/整理候选/完成）+ 取消、用量、诊断；最多 3 个候选并排比较（问题、活动、前置条件与确认状态、产出与投入、第一步、信息缺口、原文片段与来源取回状态）；保存为想法 / 不采纳（四类反馈）/ 编辑项目草案开始。
- 建项目：主人编辑标题/问题/产出/最多 5 个任务，勾选已具备条件；仍有未知必须勾选"带这些未知条件开始"。创建独立项目对象，重复点击不建第二个。
- 项目页"探索结论"：开始倾向、实际活动、继续/换方向/未定、理由、引用成果；未填写时显示"探索结论未填写"。
- API：`POST/GET /explorations`、`GET /explorations/:id`、`POST /explorations/:id/cancel`、`GET /candidates`、`GET/PATCH /candidates/:id`、`POST /candidates/:id/create-project`、`GET/POST /exploration-topics`、`GET/PATCH/DELETE /exploration-topics/:id`、`POST /exploration-topics/:id/run`、`GET /practice-templates`、`GET/PATCH /practice-templates/:id`、`GET/POST /projects/:id/conclusion`。
- worker：新增 exploration job 类型；每趟先调度到期 topic。

**关键规则/数据变化**

- 迁移 0008：practice_templates（3 个 draft 种子）、exploration_topics、exploration_runs、search_hits、evidence_documents（只插入）、candidates；projects 增加 candidate_id/start_inclination/结论列。
- 新组件：`src/integrations/{openai-chat,model-json,tavily,fixtures}.ts`、`src/contracts/exploration.ts`、`src/domain/exploration.ts`、`src/repositories/exploration.ts`、`src/workflows/{exploration,candidates,topics}.ts`；UI `ExploreView/TopicList/ExplorationRunView/CandidateCard/ExplorationConclusion`。
- 集成状态：`fake` 协议现在确实可用；openai-chat 缺字段显示 error 而不是 not_configured。

**验证**

- `npm test` 58/58（新增 14：canonical URL、片段校验、周期计算、OpenAI 适配器修复/429、Tavily snippet/failed_results/429/432、未配置 503、F7、F8、确认条件后可开始、F15（429 有界重试、仅摘要、无效 JSON）、伪造引用不发布、F16、取消、定期去重/错过周期/停用）。
- `scripts/smoke-t5.sh`（fixture）23/23：401、422、202、幂等重放、worker 执行、未知条件 422、带未知开始 201、重复 200、结论、定期开关与 409、立即运行、模板 ready 校验、页面 200。
- **真实联调（fixture 以外）**：用主人提供的 OpenAI 兼容端点 + Tavily 跑一次按需探索，36 秒完成：3 query、6 页提取（5 页取回原文，1 页仅摘要）、2 次模型调用、0 重试，3 个候选全部引用校验通过，条件均为未知。
- `typecheck`/`build` 通过；本地主库已备份后迁移到 v8。

**未完成 / 受限**

- 浏览器人工检查与移动宽度未做（页面 200 + 代码级）。
- 定期结果并入周报邮件留 T6；实践模板来源与许可未核实（仍为 draft）。
- 真实联调只跑了一次按需探索；定期真实运行、F15 真实 429 未在真实端点复现（由单测覆盖）。

**下一项**：T6 复盘与主动建议 —— 周记录查询、草稿、独立提案、反馈规则、预算。

## 待修清单第 1–3 项 —— 已修（2026-09-28）

- 幂等：`runIdempotent` 把 check → execute → record 放进同一个 IMMEDIATE 事务（并发同键重放、崩溃回滚不留半成品）；业务错误用 `HttpError` 抛出并回滚、不记录键。artifacts / proposals / availability 创建现在要求 Idempotency-Key；周重点带键时先查幂等记录（网络重发不再 409）。前端：任务表单与成果、探索的键跟随内容，同内容重试复用同一个键。
- 草稿：`useDraft` 把日志与新建任务表单存进本机 localStorage；提交时 401 不再整页跳转，提示"内容已保存在本机"并给出新标签页登录入口（登录页支持 next，仅站内路径）；页面加载时的 401 由 AppShell 的 SessionGuard 跳登录。日志日期改用实例时区今天，日志可关联全部未结束任务并自动带上项目。
- 排程：planningRevision 在 updateTask 同一事务内递增，只在时段/归属周真正变化时递增；周重点变化不再递增。排到时段时按规划时区同步 plannedWeek。apply 校验 inputVersions 快照、start<end、与固定事件冲突（409 FIXED_EVENT_CONFLICT）。plannedWeek 必须是周一；归属周改为下拉选择周一。空 PATCH 也校验版本；due 同值不递增 reminderRevision。
- 验证：新增 test/fixes.test.ts 5 项，`npm test` 63/63；smoke T1–T5 全过（T2 按新契约补幂等键）。

## T6 复盘与主动建议 —— 本地工程完成，真实模型联调通过（2026-09-28）

**实际实现的可见行为**

- 记录旁"分析这个卡点"：主人点击才分析（不发 AI 邮件）；显示实际读取范围、可能原因（推测）、可验证的下一步、需要补充的信息和最多 1 份提案；可重新分析。
- `/reviews`：生成指定周复盘（默认上周）、复盘列表、所有待处理建议逐份整体应用/拒绝（四类原因）/暂缓到明早；最近处理过的建议可回看。
- `/reviews/[id]`：事实（记录、完成任务、成果、负担）/ 模型推测（带依据）/ 建议（修改前后值、依据标签、过时原因）/ 我的复盘（本人总结与下周打算，本机草稿，与 AI 草案分开，修订次数可见）。没有记录时说明依据不足，仍可手写。
- 设置页"AI 用量与预算"：今日模型/搜索次数与 token、每日上限、是否允许定期任务、每周自动生成上周复盘的时间。
- API：`POST /assistant/requests`（202，缺模型 503，超额 429）、`GET /assistant/requests/:id`、`GET /assistant/requests?logId=`、`GET /reviews`、`POST /reviews/generate`（202）、`GET/PATCH /reviews/:id`、`GET/PATCH /ai-budget`；reject 支持原因与 expectedVersion。
- worker：新增 review、assistant 两类 job；每趟调度定期周复盘。探索也接入额度与用量记录。

**关键规则/数据变化**：迁移 0009（reviews、review_edits、assistant_requests、ai_usage；proposals 增列；tasks.completed_at）。规则见 docs/decisions.md T6。

**验证**

- `npm test` 70/70（新增 test/review.test.ts 7 项：无记录资料不足且不调模型、卡点→建议→应用→计划更新主闭环与读取范围、编造 ID 整份丢弃、14 天冷却与主动重跑、周复盘三分离与主人修订、未配置模型、预算 429 与只出事实）。
- `scripts/smoke-t6.sh`（fixture）23/23。其余 smoke T1–T5 通过。typecheck/lint/build 通过。
- 真实联调（OpenAI 兼容端点）：卡点分析 14 秒，2 条可能原因、3 条下一步、1 份提案（引用真实记录）；周复盘首次因模型把 status 写成 in_progress 失败 → 加别名归一化后重跑通过，2 条事实复述、2 条推测、2 份提案，无丢弃。共 4 次模型调用、约 1 万 token。
- 本地主库已备份后迁移到 v9。

**未完成 / 受限**

- 浏览器人工检查与移动宽度未做。
- 阶段报告 Markdown 预览/导出、周报邮件（含定期探索候选）留 T7。
- 预算不含金额；并发固定 1（单 worker 串行）。

**下一项**：T7 自部署交付 —— 草稿补交、导出（阶段报告/全量 JSON）、备份恢复（F14）、Docker Compose、迁移说明、移动 QA。

## T7 自部署交付 —— 本地工程完成（2026-09-29）

**实际实现的可见行为**

- 导出（F18）：设置页"数据导出"一键全量 JSON；项目页"阶段报告"先选字段/记录/成果 → 预览 Markdown → 可编辑 → 导出。缺失部分标"未填写"，不编造。文件存 `data/exports/`，24 小时后过期（下载 410），可删除。
- API：`POST /exports`（Idempotency-Key，202）、`GET /exports`、`GET/DELETE /exports/:id`、`GET /exports/:id/download`（鉴权、只读）、`POST /exports/report-preview`、`GET /instance`（恢复暂停状态，只读）。
- 运维脚本：`scripts/build.sh`、`start.sh`、`stop.sh`、`migrate.sh`、`backup.sh`、`restore.sh`、`resume-after-restore.sh`；Dockerfile + compose.yaml（web/worker/ops，只映射 127.0.0.1:3000）；`docs/deploy.md` 部署、迁移、备份恢复说明。
- 恢复（F14）：restore 校验 hash → 原库改名保留 → 复制 → 必要时迁移 → 写 restored_hold、epoch+1、旧 job 挂起、submitting→unknown。hold 期间 worker 不领取，测试邮件/探索/复盘/卡点返回 503 RESTORED_HOLD，所有页面顶部显示暂停提示。resume 需显式确认旧实例已停止，取消旧 job、只重建未来提醒、周期任务从下一周期开始。
- 启动检查：web（instrumentation）与 worker 启动时只检查 schemaVersion，不符即退出并提示迁移命令。
- worker 之前没读 `.env`（tsx 不会自动加载）：`npm run worker/migrate/backup/restore` 改为 `tsx --env-file-if-exists=.env`。
- UI 整体改版（13.4 T7 行）：
  - 侧栏布局：≥1100px 200px、768–1099px 152px、<768px 顶部横向五项导航。近期项目最多 3 个，设置在底部，全局"写记录"入口。
  - 配色和字号按 5.7：系统中文字体，不发外部字体请求；两种主题对比度实测 ≥ 4.5。
  - 今天页：状态带（重点 / 已知估时 + 未知数 / 未来可安排时间 + 负担条与超出文字），双栏 2:1；手机顺序为状态 → 行动 → 待决定 → 记录。
  - 记录表单：可见标签、四态（本机草稿 / 提交中 / 已保存 / 失败）、Ctrl+Enter 提交。
  - 计划页改期：原来用 `window.prompt` 输入 ISO 时间，改成行内日期/时间/时长表单，按实例时区解释。
  - 项目页：目的 / 任务 / 记录 / 成果 / 结束判断 / 阶段报告分两栏。
  - 其他：任务状态显示中文；登录与初始化页有样式；跳到主要内容链接；手机触摸目标 ≥ 44px。
- 修复：`useDraft` 读取与写回同一轮 effect，初始空值会覆盖刚读到的草稿，导致 clientEntryId 丢失、重新登录后再提交变成新记录（浏览器检查发现）。改为读完才写回，QuickLogForm 等读完才补 ID。

**验证（本地真实执行）**

- `npm test` 76/76（新增 test/delivery.test.ts 6 项：schema 版本一致、阶段报告只含所选、full_json 表白名单覆盖全部表且不含凭证、导出过期 410 与删除、F14 hold 无外部请求与只重建未来提醒、hold 期间改期不重复建）。
- `scripts/smoke-t7.sh` 29/29：导出 401/202/下载/删除后 404；运行中备份被拒；停机备份；schema 过旧 web 退出；restore → hold → 503 → worker 不领取 → 未确认不解除 → resume → 未来提醒重建。T1–T6 冒烟全部通过。
- 浏览器 `scripts/ui-check.sh`（本机 Edge 无头 + playwright-core 1.63.0，fixture 数据）112/112：
  - 亮/暗 × 320/390/768/1024/1440 × 今天/计划/探索/收件箱/回顾/设置：无横向溢出。
  - 320/390 下触摸目标 ≥ 40px；手机今天页顺序正确；宽屏状态带与行动在首屏。
  - 7 组颜色对比度 ≥ 4.5（两种主题）。
  - 键盘：Tab 到跳转链接、焦点可见、Ctrl+Enter 提交。
  - U7：401 不显示虚假成功、输入保留、刷新恢复草稿、重新登录后同 ID 只一条。
  - 截图在 `data/ui-check/`。
- typecheck / lint / build 通过。本地主库已备份（`data/dash-campus.backup-20260929-091149.db`）后迁移到 v10。

**未完成 / 受限**

- ~~Docker 镜像与 compose 未实际构建运行；HTTPS 反代只给示例；未远程发布~~（已在生产构建并上线，见下节）。
- 浏览器检查只覆盖主页面的布局与 U7/U9/U10 部分项；探索候选比较、收件箱纠正、提案过时等页面只查了溢出，没逐个走交互。减少动效只在 CSS 层处理，未单独验证。
- SMTP 已配置并验证登录（本机 465、生产 587），**尚未发出任何真实邮件**；周报邮件（含定期探索候选）未做。
- 待修清单 4、6、7、8 剩余项未做（容量区间合并、unknown 重发 UI、timing-safe 与登录限速、leaseToken 暴露等）。

**下一项**：见下节"当前状态"。

## 生产上线 —— 已部署（2026-09-29）

**已完成并验证**

- 部署到一台 Debian 13 共享 VPS（主机地址不入库）：`/opt/dash-campus`，`docker compose` 运行 web + worker（`restart: unless-stopped`），web 只映射宿主环回端口（`DASH_PORT`）。
- 镜像在服务器上首次实际构建成功（Node 24，better-sqlite3 编译通过）；迁移到 schemaVersion 10；空库。
- HTTPS：宿主已有 Caddy 2.6，在 Caddyfile 末尾追加独立站点块（改前备份、`caddy validate` 通过后 reload）；Let's Encrypt 自动续期；HTTP 301 到 HTTPS；HSTS。其他站点与容器未改动。域名不入库。
- 外网验证：health 200；未登录数据接口 401；三项集成均 configured；容器内可达模型端点与 Tavily（未调用模型）；SMTP 587 登录成功（未发信）。
- 主人已完成 `/setup` 初始化并登录；`/setup` 再次调用返回 409 ALREADY_SET_UP；生产 `SETUP_TOKEN` 已清空。
- 本地源码与生产源码逐文件 sha256 一致（src、migrations、scripts、package*.json、Dockerfile、compose.yaml）。本地 typecheck / lint / 76 项测试通过。

**上线中发现并处理**

- 宿主 3000 被其他服务占用 → compose 端口改为 `${DASH_PORT:-3000}`，生产设 3020。
- `data/` 属主不是容器用户 → `SQLITE_CANTOPEN`；改为 `chown 1000:1000 data backups`、700。
- 主机出站 465 被封 → 生产 SMTP 改 `587` + `explicit`（STARTTLS）。本机 `.env` 仍是 465（本机 465 可用）。
- 主人粘贴 SETUP_TOKEN 报"不正确"（服务端值与容器内一致，问题在粘贴内容）→ setup 接口去首尾空白、容忍 `SETUP_TOKEN=` 前缀、错误提示给出字符数、改为常量时间比较。
- `instrumentation.ts` 在 dev 下报 Edge Runtime 不支持 `process.exit` → 检查逻辑拆到 `instrumentation-node.ts`，只在 Node 运行时动态导入。
- web 日志有 4 条 `Server Reference ID did not match`：项目无 server action，判断为外部扫描请求，未处理。

**当前状态（2026-09-29 定稿）**

| 项 | 状态 |
| --- | --- |
| T0–T7 本地工程 | 完成；76 单测、T1–T7 冒烟、浏览器检查 112 项通过 |
| 生产 | 已上线并完成初始化（地址不入库） |
| 真实模型 / 搜索 | 本机联调通过（T5、T6）；生产只验证可达，未实际调用 |
| 真实 SMTP | 登录验证通过；**未发送过真实邮件**（等主人明确说"发"） |
| 完整 Web V1 判据 | 未满足：缺真实邮件发送验收、三条浏览器闭环全量走查 |
| T8 兼容迁移 | 未开始，需要旧工具数据与主人确认 |

**待主人决定 / 操作**

1. 测试邮件：回复"发"后，从生产向 MAIL_TO 发一封测试邮件并核对投递状态。
2. 安全收尾：曾在聊天里出现过的服务器与邮箱凭证应轮换；关闭 root 密码登录需主人确认自己有可用密钥。部署用本机专用密钥，公钥不入库。
3. 生产 worker 已在运行：探索、复盘、卡点分析会真实调用已配置的模型与 Tavily，计入每日额度（默认 40/30）。

**剩余工程项**

- 待修清单 4、6、7、8 余项：固定事件区间合并、unknown 投递重发 UI、inFlightOldReminders 渲染、CSRF 常量时间比较与登录限速、关联 ID 不存在返回 500、jobs 接口返回 leaseToken、DST（F19）。
- 周报邮件（含定期探索候选）。
- 探索候选比较、收件箱纠正、提案过时等页面的浏览器交互走查。


## 待修清单 4、6、7、8 与 F19 —— 已修（2026-09-30）

**实际实现的可见行为**

- 容量（4）：同一天重叠的固定事件合并后只扣一次；只覆盖周中几天的可用窗口也算"有时间数据"（此前只看周一和周日）。
- T3 界面（6）：
  - 设置页投递记录里，结果未确定或失败的投递有"重发…"按钮，两步确认并说明可能重复；重发后显示"第 N 次尝试"和"已重发"。
  - 新增"存在发送中的旧提醒"区块（改期前已交给发送服务的提醒）。
  - 预览邮件可以选任一未结束任务，不再只有合成示例；时间显示为本地格式。
  - API：`POST /deliveries/:id/resend`（需 `confirmDuplicateRisk: true`；409 NOT_RESENDABLE / ALREADY_RESENT / STALE_REMINDER / TASK_INACTIVE；恢复暂停 503）。
- 安全与健壮性（7）：CSRF 常量时间比较；登录限速（429 + Retry-After）；引用不存在的目标/项目/任务返回 422 `INVALID_REFERENCE` 而不是 500；目标空 PATCH 不再递增版本，项目空 PATCH 也校验版本。
- 其他（8）：jobs 接口与测试邮件响应不再返回 leaseToken；首页近期行动按计划重排（今天含今天计划的时段；临近只看 7 天内；无时间且不属本周的任务不上首页），分组标题改为"今天 / 未来七天 / 本周未定时"。
- DST（F19）：不存在的当地时刻后移到第一个有效时刻，重复时刻取较早一次，并返回调整标记。

**关键数据变化**：迁移 0011（`deliveries.resent_from` + 部分唯一索引），`EXPECTED_SCHEMA_VERSION` = 11。**生产升级需要停机 → 备份 → migrate**（deploy.md 第 4 节），否则 web/worker 会因版本不符拒绝启动。

**验证（本机 Linux 容器实测）**

- `npm test` 92/92（新增 16：workload 2、hardening 6、resend 4、dst 4）。typecheck / lint / build 通过。
- smoke T1–T7 全部通过（13 / 12 / 13 / 18 / 23 / 23 / 29）。smoke 脚本此前只能在 Windows Git Bash 下正确清理进程，已改为跨平台。

**未完成 / 受限**

- 设置页新区块没做浏览器实测（ui-check 依赖本机 Edge，本环境没有）。
- 周期 occurrence 唯一键未包含 DST 选择的偏移。
- 生产尚未升级到本批代码。
- 周报邮件（含定期探索候选）仍未做；三条浏览器闭环全量走查仍未做。
