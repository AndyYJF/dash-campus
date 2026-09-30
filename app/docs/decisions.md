# 决策记录

按 CODING-AGENT-开发执行计划 v1.2 第 0 节：本文只记录未约定的小问题的最小实现选择。

## 2026-09-28 T0

- 脚手架 `create-next-app` 参数：App Router + src/ 目录 + CSS Modules（--no-tailwind），符合计划"CSS Modules + CSS 变量"。
- 版本基线（当日稳定版）：Next 16.3.6 / React 19.2.8 / TypeScript 5.x / better-sqlite3 13.0.3 / zod 4.6.5 / tsx（迁移与脚本运行器）。lockfile 已生成。
- 模型协议缺口：T0 无任何真实协议接入，`SUPPORTED_MODEL_PROTOCOLS` 为空；`MODEL_PROTOCOL=fake` 时由 `FakeModelProvider` 支撑本地 fixture 工作流，不冒充真实模型。真实适配器留到 T5 接通经用户端点验证的协议。
- 迁移运行器：`migrations/NNNN_name.sql` 按文件名数字排序执行，版本写入 `schema_version`（单行，id=1）。服务进程不自动迁移，只由 `scripts/migrate.sh` 执行。
- 脚手架辅助脚本放在项目外的 `Dash-campus/scripts/scaffold.sh`（一次性），项目内 `scripts/` 按运维脚本契约维护。

## 2026-09-28 T1

- 密码散列用 Node 内置 `crypto.scryptSync`，格式 `scrypt:<salt>:<hash>`，不引入 bcrypt 依赖。
- CSRF 方案：会话 cookie httpOnly + SameSite=Lax，变更请求必须带 `x-csrf-token` 头且与会话绑定；登录/setup 属会话建立操作，不做 CSRF 校验（计划第 9 节仅豁免幂等键，此处为最小实现选择）。
- 幂等重放返回首次的 statusCode + body；同键不同体 409 `IDEMPOTENCY_COLLISION`；幂等键以会话 id 为 actor_scope。
- 创建 POST 缺 Idempotency-Key 返回 422 `IDEMPOTENCY_KEY_REQUIRED`（计划第 9 节要求携带，未指明状态码，取 422）。
- 测试用 node:test + tsx，每个测试文件独立临时库（`test/helpers.ts` 设置 DATABASE_PATH 后迁移）。

## 2026-09-28 T2

- 时区实现选 Node 内置 Intl（维护中的时区库），不引入 luxon/dayjs。墙钟→UTC 用迭代逼近（3 次收敛）；DST 特殊规则（不存在时刻后移/重复时刻取早偏移）未实现，记为缺口，F19 的 DST 用例在实现排程提醒时补。
- workload 的 `hasAnyTimeData` 按"覆盖本周的窗口"判断，而非全局有窗口——否则别周的配置会让无配置周显示容量 0 而非 null。
- 提案 apply 里 updateTask 的 version 检查可能因排程 bump 叠加导致冲突误判，故 planningRevision 校验放在读集校验之前，且只对排程敏感操作生效。
- 冒烟脚本坑：Git Bash 下 curl 命令行内联中文 JSON 会转码乱码，中文负载必须 `printf` 到临时文件用 `-d @file`；`npm run start` 的孙进程会逃出 trap 的 `taskkill //T`，脚本内改用 `npx next start` 直接起 node。

## 2026-09-28 T3

- 提醒触发点默认值（计划 4.3 允许默认）：date 型 = 截止日当天 09:00（任务 due 时区）；instant 型 = 截止时刻前 24 小时。任务 schema 暂无用户自选提前量字段，V1 不提供选择；加字段时属后续任务。
- reminderRevision 递增的字段映射（计划 8.2 只列"截止、提醒规则、终态、归档、重开"）：due 三列任意变化、状态变为 done/cancelled、从 done/cancelled 重开、归档。scheduled_start/end 与 plannedWeek 变化不递增——V1 提醒只基于 due。标题/备注变化不递增，正文在准入时用最新标题生成（符合 8.2"未准入邮件使用发送时最新标题"）。
- "提醒未过期"的实现解释：越过 due 边界（date 型当地次日 00:00；instant 型 at 本身）即视为过期，job 以 skipped/overdue 结束不发送，任务自然出现在逾期与待处理列表，不补发无意义提醒。
- 过去触发点不建 job（8.2"过去触发点进入今日待处理"）：`GET /notifications` 的 pendingReminders 按此口径查询呈现；notifications 是最小实现（pending/upcoming/在途旧投递/近期投递四段），不是完整通知中心。
- jobs.type 不用 CHECK 封死枚举，T4+ 新类型免迁移；`POST /jobs/:id/cancel` 只放行 reminder 类型（计划：取消接口只允许可见可取消的作业类型）。
- worker 单实例前提：recoverOnStartup 越过 token fencing 直接恢复孤儿 job/在途 delivery，理由是"一个实例一个 worker、启动时不存在其他执行者"（计划 8.1 允许一个 worker 遵守这些规则处理异常重启重叠）；恢复把 submitting→unknown 且对应 job 落 done，不自动重发。
- Mailer 注入：`setMailerForTests` 覆盖 `resolveMailer()`；SMTP 未配置返回 null，调用方报 503 INTEGRATION_UNAVAILABLE。测试邮件（mail/test）的 delivery 没有父 job，用独立随机 lease_token 满足 markOutcome 的条件更新。
- `POST /mail/preview` 与 `/mail/test` 不要求 Idempotency-Key：preview 不创建任何资源；test 是主人显式点击的一次性动作（产生 delivery 记录但无幂等创建语义），重复点击即重复发送，与"unknown 重发提示可能重复"的处理一致。
- settings 行不存在时 version=0 表示首次创建（PATCH expectedVersion=0 为 INSERT，主键冲突返回 409）；模板配置存 settings 表 `mailTemplate` 键，读取时与 Zod 默认值合并。


## 2026-09-28 T4

- 冒烟脚本进程清理：Git Bash 的 `$!` 是 MSYS pid，`taskkill` 杀不到 Windows 侧 node，残留进程锁住 smoke 库。改为共用 `scripts/smoke-lib.sh`：按 `/proc/<pid>/winpid` 结束，再按监听端口兜底。

## 2026-09-28 T0–T4 审查修复

- PATCH schema 不再用 Zod 4 的 `.partial()`（它保留 `.default()`，未传字段会被补默认值写回库）；改为 `patchShape()` 去 default 后 optional。
- 带 SMTP 副作用的提醒 job 被重领时，若已有 submitting/accepted/unknown 投递则不再发送（submitting 标 unknown），落 done；过期租约不能续租；worker 每趟只领取 1 个 job（串行执行时批量领取会让后面的租约在等待中过期）。
- worker 启动恢复只处理 job 发起的投递；测试邮件（job_id 为空）由 web 进程自己落结果。
- 时刻字段（due.at、scheduledStart/End、snoozeUntil）要求带偏移的 ISO 8601。

## 2026-09-28 T5

- 真实模型协议：OpenAI 兼容 Chat Completions（`MODEL_PROTOCOL=openai-chat`），用户端点实测 200、`response_format: json_object` 可用。`MODEL_ENDPOINT` 为 base URL，自动补 `/chat/completions`。模型名由主人指定（`MODEL_NAME`），代码不写死。
- 结构化输出：JSON 解析容忍 ```json 包裹；schema 失败把错误交回模型修复 1 次，仍失败报 SCHEMA_INVALID 停止（7.2）。
- `MODEL_PROTOCOL=fake` / `SEARCH_PROVIDER=fake` 启用本地 fixture（合成 example.org 页面），run 记 `integration_mode=fixture`，UI 显示"示例数据"。这修正了 T0 记录与实现不符（原来 fake 实际不可用）。
- 预算实现：一次 run 共用"最多重试 1 次"，模型调用与搜索共用；180 秒总预算用 AbortController 中断在途请求；续租失败同样中断且禁止提交。
- 模型输出的 requirement `met` 一律降为 `unknown`：met 只能来自主人在建项目时的确认（7.1"不能悄悄把未知变为满足"）。
- 候选引用校验：evidenceId 必须属于本 run，quote 空白归一化后须存在于证据原文；无可验证出处的候选不发布，只写诊断。
- 只有摘要的候选：evidenceStatus=snippet，自动加"原文未取得"缺口，建项目时视为未确认条件，必须"带未知条件开始"。
- 未取得原文的搜索摘要最多保留 6 条作证据（真实联调中 3 个 query 返回 14 条结果，摘要会挤占模型上下文）。
- 去重：同 topic + canonical URL 且 evidence_hash 相同不再发布；内容变化发布新候选并记 supersedes_id。按需探索（无 topic）不跨 run 去重。
- 定期：next_run_at 按实例时区每周计算；错过多个周期只入队一个 run（以"现在"为基准推进，条件更新防重复）；上一次未结束不叠加。topic 修改/停用版本 +1 并取消未开始的旧 run；在途 run 发布前在同一 IMMEDIATE 事务重检 enabled 与版本（F16）。
- 周报合并与"定期结果邮件"留 T6（计划：结果并入周报），T5 只把候选落库并在探索页展示。
- 实践模板 3 个均为 draft；PATCH 标 ready 需至少一个来源链接且每个写明许可。具体数据集/教程来源本轮未核实填写。
- 项目表增列：candidate_id、start_inclination 与结论字段（7.3），不另建表。

## 2026-09-28 待修清单 1–3

- 幂等统一走 `runIdempotent`：check → execute → record 同一 IMMEDIATE 事务，execute 必须同步（better-sqlite3 事务不能跨 await）；业务错误抛 `HttpError` 回滚且不记录键。
- 401 不再整页跳转：提交中 401 提示并保留本机草稿（`useDraft`，localStorage），给出新标签页登录入口；页面加载 401 由 SessionGuard 跳登录。登录 `next` 只接受站内相对路径（防开放重定向）。
- planningRevision 改在 `updateTask` 事务内、仅在时段/归属周真正变化时递增；周重点不再递增（第 6 节只列课程、可用时间、任务计划时间）。
- 固定事件冲突 V1 只判同一当地日内的时段；跨日时段不细判（记为限制）。

## 2026-09-28 T6

- 周复盘"事实"由程序汇总（`weekFacts`：记录、本周完成、未完成、成果、负担、上周复盘建议处理结果），始终可用；模型只给 factNotes/observations/proposals，三者分开存。无记录 → `insufficient`，不调用模型。模型未配置/超额/失败 → 仍 `ready`，AI 部分写明跳过原因。
- "本周完成"需要完成时刻：tasks 增加 `completed_at`（进入 done 记录，离开清空）；迁移把已有 done 任务的 updated_at 回填为近似值。
- 模型提案翻译：evidenceIds 必须属于上下文；taskId 必须在范围内（复盘=本周相关未完成任务；卡点=本项目未完成任务或记录关联任务）；任一操作不合法整份丢弃（不做半份），丢弃原因写进草案 `dropped` 可见。读集快照由程序生成。AI 不改 due（4.1）。
- 冷却指纹 = sha256(项目 | 操作类型集合 | 证据 ID 集合)；拒绝后 14 天内同指纹不自动提出；同指纹已有待处理也不重复；卡点"重新分析"（rerun）跳过拒绝冷却。
- 卡点分析范围：有项目 → 该项目最近 7 天记录 + 项目未完成任务；无项目 → 本周记录 + 关联任务。所选记录总在范围内。最多 1 份提案。结果记录实际读取范围（readScope）供 UI 展示。
- 预算只做次数：每日模型调用、每日搜索调用（实例时区自然日），默认 40/30，可在设置改；不估算金额。结构修复按实际请求数计入。达到上限：探索/卡点 429 BUDGET_EXCEEDED，复盘只出事实；截止提醒不受影响。`scheduledEnabled=false` 时定期探索与定期复盘只推进时间不入队。
- 定期周复盘：设置里开启并选每周几/时间，到点生成"上周"复盘；下次时间存 settings（`weeklyReviewNextRun`），错过多个周期只生成一次。
- 真实联调发现模型会把 status 写成 `in_progress` 等别名，导致整份输出 SCHEMA_INVALID；status 改为先归一化别名（含中文）再校验，并在指令里写明枚举。
- 提案表增加 source_kind/source_id/project_id/version/rejection_reason；reject/snooze 接受可选 expectedVersion；暂缓默认到实例时区次日 09:00。
- 阶段报告（Markdown 导出）按计划属于 T7 导出，本轮未做。

## 2026-09-29 T7

- 导出同步生成：本地计算、无外部调用，POST 直接落文件并返回 202 + ready/failed（202 语义不变：不代表已下载）。文件先写临时名再改名；删除只允许导出目录内的路径。下载 GET 只读：到期直接 410，不改状态，清理由 worker 每趟和列表读取时做。
- full_json 用表白名单：每张表必须显式列入"导出"或"排除"，测试会检查新表有没有归类。
  - 排除：owner、sessions、idempotency_keys、jobs、deliveries、ai_usage、exports、instance_state、planning_state、schema_version。
  - inbox_sources 去掉 token_digest；settings 去掉调度内部键；各类 job_id 列去掉。
- 阶段报告的字段取数：
  - 目标与理由：关联目标 + 问题 + 预期产出。
  - 行动：所选记录的进展。
  - 成果：所选成果。
  - 困难：所选记录的卡点 + 结束判断理由。
  - 下一步：项目未完成任务。
  - 所选 ID 不属于该项目的，忽略并返回 ignoredIds。
- 恢复控制放数据库单行表 `instance_state`（restore 命令写入），不用独立控制文件：一个 SQLite 文件就是全部状态，备份/恢复也不会漏掉它。restore 会把 restored_hold 重设为 1，所以恢复一个处于 hold 的旧备份也是 hold。
- 旧 job 挂起用 `jobs.hold_state='restored_pending'`（claim 条件排除），不新增 status 值：jobs.status 的 CHECK 约束改表成本高。resume 时统一取消，并给 dedupe_key 加 `:restored-e<epoch>` 后缀，释放给按当前任务重建的新提醒。
- resume 重建提醒复用 `refreshReminders`：它只建触发时间晚于现在的 job；hold 期间主人改过的任务已有新 revision 的 queued job 时跳过，避免取消重建。
- 停机检查：worker 每趟写心跳（instance_state.worker_heartbeat_at），20 秒内有心跳视为在运行；web 用 health 端点探测。backup/restore 任一在运行即拒绝。resume 不查心跳，只要求主人确认"旧实例已停止"——新实例无法替主人保证远端旧实例。
- web 启动检查放 `src/instrumentation.ts` 的 register（Next 16 文档：服务实例启动时调用一次，完成前不接请求），构建阶段跳过。
- 字体改为系统中文无衬线，去掉 next/font/google（5.7：无需外部字体请求）。
- 浏览器检查选 playwright-core + 本机 Edge（不下载浏览器），开发依赖，版本固定 1.63.0。tsx 编译会给具名函数加 `__name`，页面里没有这个全局，所以用 addInitScript 注入空实现。
- tsx 从 devDependencies 移到 dependencies：worker 与运维命令在生产镜像里直接用 tsx 运行源码（一个镜像两个命令）。

## 2026-09-29 生产上线

- 复用宿主已有 Caddy 做 HTTPS，不在 compose 里再起一个反代：80/443 已被宿主 Caddy 占用，且它还服务其他站点。只追加独立站点块，改前备份、校验后 reload。
- web 只映射到宿主环回（`127.0.0.1:$DASH_PORT`），不暴露公网端口；端口通过 `DASH_PORT` 配置，默认仍 3000。
- SMTP 端口按主机网络选择：该 VPS 出站 465 被封，用 587 STARTTLS（`SMTP_TLS_MODE=explicit`）。
- setup token 比较：去首尾空白、容忍 `SETUP_TOKEN=` 前缀，常量时间比较；错误信息只给长度，不回显内容。初始化完成后清空生产 `SETUP_TOKEN`（`hasOwner` 已使其失效，清空是多一层保险）。
- 部署用本机专用 SSH 密钥，公钥与服务器地址不入库，不在任何文件里保存服务器密码。


## 2026-09-30 待修清单 4、6、7、8 与 F19

- 登录限速放内存：web 单进程，重启清零可以接受，不为此加表。按来源地址每 15 分钟 10 次失败，另设全局 100 次防换地址穷举；达到上限时连正确密码也先返回 429（否则限速对猜中的那次无效）。成功登录清掉该地址计数。来源取 `X-Forwarded-For` 最后一跳：web 只监听环回，前面的 Caddy 不信任客户端传来的 XFF（未配 trusted_proxies），会用真实地址覆写。
- 外键失败统一映射为 422 `INVALID_REFERENCE`：`runIdempotent` 兜住所有创建，任务/项目 PATCH 和记录 POST 用 `withReferenceCheck`。不在每个路由里逐个预查 ID——数据库外键已经是唯一可信判据。
- 首页近期行动按 v1.2 第 4 节重排：今天 = 今天计划（时段开始在今天）或今天截止；临近 = 未来 7 天内的时段或截止；本周未定时 = 归属本周。三者都不满足的任务不上首页（此前被归到"临近截止"）。组内先有具体时间的，再高优先级，再创建顺序。分类挪到 `src/domain/today.ts` 以便单测。
- 显式重发（unknown/failed）：由 web 进程直接发送（与测试邮件同一路径），不经 worker、不自动重试。沿用原投递的收件人与正文快照，只换新 requestId、attempt+1；新列 `deliveries.resent_from` + 部分唯一索引保证同一条原投递只能重发一次，重复点击 409。提醒类要求任务未结束且 reminderRevision 未变，改期后的旧提醒不重发（新提醒由 job 负责）。请求必须带 `confirmDuplicateRisk: true`，界面两步确认并说明可能收到两封。
- web 进程发送（测试邮件、重发）若在 submitting 时崩溃会停在 submitting：worker 启动恢复只处理 job 发起的投递，这一点与测试邮件既有行为一致，未改。
- DST（F19）：`resolveWallTime` 以当天前后 24 小时的两个偏移为候选，逐个验证；两个都成立 = 重复时刻取较早 instant（overlap_earlier）；都不成立 = 落在跳过区间，二分到转换点（gap_shifted）。`wallTimeToUtc` 保持签名不变。周期 occurrence 的唯一键尚未包含"选择的偏移"，调整标记也还没持久化到 occurrence（当前实例时区 Asia/Shanghai 无 DST，不影响）。
- smoke 脚本的进程清理改为跨平台：有 `taskkill` 走原 Windows 路径，否则按进程树 `kill`。T7 的 schema 版本从 `EXPECTED_SCHEMA_VERSION` 读取，不再写死。

## 2026-09-30 生产升级后的修复

- 备份/恢复的"web 是否仍在运行"检查改为：health 响应体里 `service === "dash-campus"` 才算运行中。原来只要有 HTTP 响应就算，而生产的 `APP_BASE_URL` 经过 Caddy，web 停止后 Caddy 回 502，检查永远不放行。仍然走 `APP_BASE_URL` 而不是改成连容器地址：源码部署和 Compose 部署共用一套判据，web 在运行时经代理也能拿到本应用的响应。数据库异常时 health 返回 503 但仍带 service 字段，这时 web 确实在运行，照样拒绝。
- 冒烟脚本在 `smoke-lib.sh` 里 `unset FORCE_COLOR`：断言按字符串比较 node 打印的值，FORCE_COLOR 会给数字和布尔值加 ANSI 颜色码（"11" != "11"）。只影响设置了这个变量的环境（如 AgentBox），不改各脚本的断言写法。
