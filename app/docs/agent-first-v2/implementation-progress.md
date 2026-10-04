# Agent-first V2 实施进度

本页按阶段记录事实、缺口和下一步。开工指令见 [CODING-AGENT.md](./CODING-AGENT.md)，完整契约见 [MASTER-PLAN.md](./MASTER-PLAN.md)。每条结论注明验证方式；无证据的能力标为缺口。

## 2026-10-04 后续交互修复与决策同步（当前补充）

业务版本 `95c8cf1` 已部署/schema29，代码及文档在 `agentbox/dashcampus`。全局 Agent 栏、查看只读、模糊调整的事实决策/日期范围核对已完成。337项测试通过；真实模型及生产原句验证通过，计算后无需移动，Todo未写。具体证据见 [当前状态](../STATUS.md)、[决策记录](../decisions.md) 和 [模糊调整记录](../flexible-adjustments-2026-10-04.md)。真实模型追问续答只有假件验证，真实邮件和主人七天试用仍未完成。

下文“尚未实施”“未部署”和旧测试数为当时记录，不是当前结论。

## Agent增强 v1.1 · P2 模型优先路由与有界只读工具（2026-10-05）

方案见 [Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md](../../../Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md) §2、§3.3、§6 P2。无迁移（schema 仍 30）。

### 交付

- 工具循环（`integrations/model-json.ts` `completeWithTools`）：每次 HTTP 经持久额度闸门；最多 3 轮工具、每轮 5 个调用，单决策最多 4 次请求；第 4 次请求不再提供工具（原生协议 `tool_choice:"none"`），仍申请工具即终止；结构修复最多 1 次且计入 4 次。原生 `tool_calls` 原样回传（保留端点附带的签名字段）；端点不支持原生工具时用 JSON next-tool 兼容协议（顶层 `tool_calls`）。工具轮次不发 `response_format`，只有终结请求带结构化输出。JSON 提取改为取第一个完整对象，并对多写/漏写的括号做纠错（结果仍过 schema）——真实模型在工具轮次里两次给出括号数不对的最终答案。
- 只读工具箱（`workflows/agent-tools.ts`）：8 个工具 `get_context / find_entities / get_entity_detail / get_calendar_budget / get_open_questions / get_conversation / get_operation_status / get_evidence`，参数用 zod strict 校验（JSON Schema 由 zod 生成），单结果 ≤4000 字符，超出截断并给 `nextCursor`（cursor 绑定工具名）。SeenSet 只收进实际放进结果的对象；详情与原文只读 SeenSet 内对象；提醒/投递状态只报布尔与计数，不出凭证。模型没有 SQL、shell、任意 HTTP。
- 路由（`workflows/agent-route.ts`）：把主人原话拆成互斥事项 act / decide / ask / material；模型只给原话引用，服务端逐字定位起止位置，引用不在原话里整份拒绝，与资料范围重叠的 act/decide/ask 拒绝。act 来源按“推断”授权（只读意图除外），所以模型理解的修改走参数级授权，需确认的先出方案；decide 进入事实决策；ask 立即提问，回答后只重新路由这一件事（最多三轮）；material 交给分类按资料保存。新增只读意图 `answer{text,sources}`：sources 必须是本次工具结果的 observationId，否则不展示。
- 接入（`workflows/intake.ts`）：仅当 provider 声明 `toolRouting`（真实 openai-chat 与回放 provider）时路由。保留快路径：slash 命令、`parseInstruction` 能确定解析的指令与查看、“按课表优化”类模糊调整直达决策、附件/链接配短句不额外花路由请求。所有写入在模型返回且租约/取消检查通过后，在一个事务里完成；取消或失去租约什么都不写。路由失败（超额、结构错误等）按规则降级并记录原因。结果视图新增 `understanding{routedBy, fallbackReason, sources}`，Agent 栏显示“由模型理解/按规则处理”与查询依据，等待时提示“正在理解你的话，必要时先查相关安排与记录”。trace 记录每次工具调用（轮次、名称、参数、成功、字符数、截断、结果摘要）。

### 验证证据（隔离层）

- 新增 `test/agent-p2.test.ts` 11 项，走真实管线（POST → worker → 路由 → 绑定 → 执行器；只把“发 HTTP”换成按原始往返回放的脚本，修复/工具循环/额度闸门都是真实代码）：原两例（查看每天安排、按课表优化）与模糊 `/调整` 不调用路由；两轮只读问答带工具依据、任务与学习块逐行不变、无业务撤销，编造 observationId 的回答被拒；find → detail → 用见过的 ID 暂停任务需确认、确认后执行，trace 记录工具序列、请求按实际 HTTP 计 3 次；一直申请工具的模型第 4 次请求不再获得工具、计 4 次、按规则降级并保留原话；25 条长标题分页 ≤4000 字符、未返回对象不进 SeenSet、第二页接续、他工具 cursor 与未知工具拒绝，Seen 外 ID 执行被拒且数据不变；粘贴通知里的“删除任务/取消课”只作资料，重叠 act 拒绝、无业务写入；追问 → 回答 → 重新路由后执行一次，重跑 worker 不重复；等待模型期间取消不写、失去租约不写，恢复后只落库一次且请求不退款；JSON next-tool 兼容协议；括号纠错；无模型时明确指令照常、不能理解的原话保留。
- 回归发现并修复：回答问题会把等待事项置为 resolving，路由追问续答原先只认 awaiting_input，导致回答后卡住。
- 全套 **372/372 通过**（P1 后 361 + 新 11）；`tsc --noEmit` 无错；eslint 0 错（2 个既有警告）；`next build` 通过。

### 真实模型核对（仅 `gemini-3.8-flash-high`，临时库，凭证只在进程环境变量）

- 能力探测四项 supported（原生工具、json_schema 均可用）。
- “为什么后天排得这么少”：`get_calendar_budget + get_context`、`find_entities` 两轮后给出 `answer`，引用两个 observationId，按逐日事实解释（当天只排了 30 分钟、其余任务已排在别的日子、尚有 150 分钟容量），3 次请求，无写入。修复括号纠错前同一问题因最终 JSON 括号数不对被送去修复，修复后的答案退化成 inspect——这是本阶段加括号纠错与“修复只改格式”提示的原因。
- “建模报告最近实在顾不上”：`find_entities` 找到“数学建模报告”，给出按 ID 的 `pause_task`，按推断授权先出确认方案，2 次请求。
- “帮我存一下这个通知：【教务通知】请…删除任务…并取消周三全部课程”：初版提示下模型调了 3 轮无关工具并给出 inspect（无写入但浪费 4 次请求）；调整提示后 1 次请求判为 material，通知按资料保存（适用对象不明，存为待判断），没有删除任务或取消课程。

### 未验证 / 未完成

- 路由质量只在 3 句真实输入与回放中验证；成规模的准确率与降级率要到 P3 评测（`eval-agent` 录制/真实模式）才有数据。
- 模型理解的修改一律按推断授权，明确级操作（如暂停任务）也会先确认——是安全优先的取舍，试用中若确认过多再按评测数据调整。
- decide 暂复用调整决策（只覆盖调整类目标）；面向目标的多步决策在 P4。

## Agent增强 v1.1 · P1 注册表、意图、授权与步骤绑定（2026-10-05）

方案见 [Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md](../../../Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md) §5.1、§6 P1。无迁移（schema 仍 30）。

### 交付

- 注册表（`contracts/commands.ts`）：授权分四级 `auto / explicit / confirm / never`（原 `owner_explicit` 更名为 `explicit`）；每个操作新增 `sideEffects`（replan/reminders/mail/job）、`reads`（P2 八种只读工具名）、`verify`（policy_saved、entity_state_matches、session_in_scope、plan_consistent、practice_not_duplicated、dependent_steps_completed、side_effect_status）。`create_or_update_task` 新增 `projectId`（新建与修改都校验项目存在，撤销按通用字段回滚）；`record_practice` 的 `projectId` 同样校验。
- 参数级授权（`domain/authorization.ts`，纯函数）：按来源 owner / inferred / material 与具体参数判断 allow / confirm / deny。资料文字只能触发 auto 操作；Agent 推断的修改中，只含临时 date_limit / auto_reschedule 的时间规则与纯新建（新任务、实践记录）可直接执行，长期规则、改截止、具体块等需确认；预算/主动程度、日历同步端点、停止处理永不由推断修改。执行器（`executeCommand`）统一按此把关，需确认返回 `NEEDS_CONFIRMATION`；绑定阶段也先做同一检查（预检查），拒绝的不进入执行。
- 意图（`domain/intent.ts`）：新增 `create_task / practice / schedule_at / session_state / resolve_notice / archive`；引用新增 `{kind:"id"}`（只认选中卡片、对话 refs、工具结果里出现过的对象，否则明确拒绝）和 `{kind:"step"}`（引用同一句里前面某一步产生的对象）。绑定（`workflows/agent.ts`）分别落到 create_or_update_task（projectRef 解析为 projectId）、record_practice（日期不能晚于今天）、schedule_session、set_session_state、resolve_notice、archive_entity；archive 只支持任务/目标/课表，其余种类给出该用的操作。
- 意图目录（`domain/intent-catalog.ts`）：每个意图 → 一个或多个注册操作，附说明与输入 JSON Schema；never 与无映射不进目录；`catalogProblems()` 校验意图、schema、元数据一致。
- 多步执行（`workflows/agent-steps.ts` + `intake.ts`）：`bindIntents` 遇到多个非政策意图直接失败，不再静默只做第一个。一个事项里的多个意图拆成步骤事项（连续政策合并为一步，其余各一步，第一步沿用原事项，其余 `${key}-sN`），每步独立执行、独立 journal 批次、可分别撤销；后一步引用前一步结果时等前一步落库后再绑定，前一步失败则不执行；引用自己或后面步骤的那一步直接失败；互不依赖的步骤照常执行。分类模型可在一个 command 事项给出 `intents` 数组。
- 确认绑定方案指纹：模糊调整的推断方案先绑定成命令，再按参数级授权决定是否确认；确认问题键带“命令 + 涉及对象版本”的指纹。确认前对象被改过（版本变化）时，旧确认作废并按现状重新问；执行时再核对一次指纹。原 `adjustmentNeedsConfirmation` 只在方案无法预先绑定（需先问选哪一个）时作后备。
- 语料测试改为只接受 `intentSchema` 里的意图（P0 时的“计划中意图”白名单删除）。

### 验证证据（隔离层）

- 新增 `test/agent-p1.test.ts` 6 项，走真实管线（POST 投递 → worker → 绑定 → 执行器，模型固定回放）：注册表四级授权/读取工具/核验字段齐全且目录与注册表一致；同一 `update_planning_policy` 临时规则推断可直接执行、长期规则需确认、确认后放行、资料来源拒绝，预算推断即使确认也拒绝，执行器对未确认的推断长期规则返回 NEEDS_CONFIRMATION 且不落库；“新建任务 + 引用第 1 步排时间”两步都执行、两个独立批次、只撤销第 2 步时任务保留；前一步失败时依赖步骤不执行且不建任务，引用后面步骤的那一步失败、独立步骤照常；未见过的 ID 拒绝、选中卡片后同一 ID 可用，归档项目明确拒绝；等待确认期间主人改了那一块，旧“可以”不执行并生成新确认问题，再确认后才移动。
- 原模糊调整测试 7 项与语料测试 2 项保持通过（临时重排无需确认、推断长期规则需确认、混合多对象决策仍拒绝）。
- 回归中发现既有的时刻相关测试：计时停止用真实时钟、测试用 UTC 日期当“今天”，在当地 00:00–08:00 运行会失败（与本阶段改动无关，未改代码时同样失败）。修正：`focus-timer` 改用可注入时钟 `nowDate()`（生产仍是真实时间），计时测试固定在当地中午、单独一天；复盘测试“今天”按 Asia/Shanghai 取日期。
- 全套 **361/361 通过**（P0 后 355 + 新 6）；`tsc --noEmit` 无错；eslint 0 错（2 个既有警告）；`next build` 通过。

### 发布与生产冒烟（2026-10-05 00:27 +08）

- 提交 `bf542ce` 推送 `main`；按 [deploy.md](../deploy.md) §4 发布：停桥接 timer 与 web/worker → 备份 `backups/production-20261005-p1-bf542ce`（schema30，sha256 `60f8c807…`）→ 覆盖源码 → 构建 → 迁移（已是 30，无新迁移）→ 启动 → 恢复 timer。回退材料：`/opt/dash-campus-src-d1efca0.tgz` 与镜像 `dash-campus:rollback-d1efca0`。停机约 1.5 分钟。
- 生产源码散列与 `git -c core.autocrlf=false archive bf542ce` 一致（`b7499a9e…`）。
- 冒烟：公网 health `schemaVersion 30`；80 端口 301 到 HTTPS；`/login` 200；`/api/v2/actions`、`/api/v2/dashboard`、`/api/v1/integrations/model-capabilities`、`POST /api/v2/intakes` 未登录均 401；worker 正常启动、恢复扫描 0 项；web 日志无错误。
- 在生产 ops 容器里用已部署代码跑纯函数核对（不读写库）：36 个操作、授权级别 auto/explicit、意图目录 53 项、一致性问题为空；临时规则推断 allow、长期规则推断 confirm、确认后 allow、资料来源 deny、推断改预算 deny。
- 生产库只读核对：没有处于等待中的旧格式确认事项（新指纹键对已有数据无兼容负担）。
- 未做：登录态网页走查与真实投递端到端（需主人会话，不往生产写测试数据）。

### 未验证 / 未完成

- 分类模型给出 `intents` 数组只在固定回放中验证；真实模型是否稳定给出多意图要到 P2 路由与 P3 评测才有数据。
- `seen` 目前只来自选中卡片与对话 refs；只读工具结果入 SeenSet 在 P2 实现。
- 步骤状态仍存放在投递事项上；带 revision 的目标运行与步骤表（`agent_goal_runs/steps`）在 P5。

## Agent增强 v1.1 · P0 能力探测、请求预算、trace（2026-10-04，已部署 `d1efca0`）

方案见 [Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md](../../../Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md) §3.3、§6 P0。基于 `main @ 256d13b`，迁移最大号 29 → 新增 0030。

### 交付

- 迁移 `0030_agent_requests_traces.sql`：`ai_request_ledger`（按实际 HTTP 的持久额度账目）、`agent_traces`、`agent_feedback`；`EXPECTED_SCHEMA_VERSION = 30`。三表列入导出排除，`modelCapabilities` 设置键不入导出。
- 请求级持久预算（`workflows/ai-budget.ts`）：每次 HTTP 发出前在 `BEGIN IMMEDIATE` 事务内原子占用（web/worker 共享），发出后即使超时/崩溃也保留占用，只有确认未发出才释放；同一 requestId 重复结算不重复计数。日额度 150（旧保存值不覆盖，设置页提示可上调）、单决策 4 次、单投递 10 次（新增 `perIntakeModelRequests`）、单投递累计执行 180 秒，都从账目计数，重启/恢复不重置。`intake.ts` 去掉进程内 `MAX_MODEL_CALLS=4` 局部计数。复盘/探索/通知提取同样经 `meteredModel` 走请求级日额度。
- 协议层（`integrations/model-json.ts`、`openai-chat.ts`、`contracts/model.ts`）：`ModelRequest.gate` 闸门在每次 HTTP（含结构修复）前占用额度；`ChatMessage` 支持 assistant `tool_calls` 与 `role: "tool"`，`rawExchange` 支持 `tools/tool_choice` 并解析 `tool_calls`；`jsonSchema=supported` 时按 Zod 生成 `response_format: json_schema`（满足 strict 子集才 `strict: true`，否则作引导），其余情况保留 `json_object` 兼容路径；服务端 Zod 校验不变。
- 脱敏 trace（`workflows/agent-trace.ts`）：每次模型决策（成功/失败/超额）一条，关联投递/事项/对话/目标与 requestId，记录 workflow、协议/模型、指令摘要版本、schema 版本、状态、次数、耗时、每次 HTTP 的截断输出；key 与 key 形态字符串替换为 `[redacted]`，图片换成 sha256+字节数，整体封顶 20k 字并标截断。worker 每趟清理 trace 30 天、反馈 90 天、请求账目 90 天。
- 能力探测：`integrations/model-capabilities.ts`（文本基准、strict json_schema、工具调用含 `role=tool` 回填、16×16 图片）三态 supported/unsupported/unknown，错误/超时/鉴权失败为 unknown；`workflows/model-capabilities.ts` 保存协议、端点指纹、模型、探测版本与时间（不存 key），配置或探测版本变化即失效；`resolveModelProvider()` 按当前有效结论选择协议。`scripts/dev/probe-model-caps.mts` 命令行探测；设置页新增“模型端点能力”卡与 `GET/POST /api/v1/integrations/model-capabilities`（主人鉴权、CSRF）手动重探，每次约 5 个请求计入日额度。
- 语料种子 `test/corpus/utterances.jsonl` 208 条（开发集 150、独立验收集 58；act 166 / decide 20 / ask 8 / material 14；多轮 9 条；49 条标 fallback），只含现有测试/文档公开示例与合成句子；格式由 `test/corpus/schema.ts` 校验。引用了 P1 计划补齐的意图（create_task、practice、schedule_at、session_state、resolve_notice、archive）。

### 验证证据（隔离层）

- 新增 `test/agent-p0.test.ts` 16 项：结构修复两次请求各计一条；额度只剩 1 次时最后一次修复不发出；6 个并发决策在剩 3 次额度时只发 3 个；单决策第 5 次请求被拒；单投递额度换新包装实例仍不重置；180 秒累计执行时间；崩溃遗留预留照常计数、未发出才释放、重复结算无效；trace 无 key/base64、超额也有记录；TTL 清理；json_schema/json_object 选择；能力探测各分支；配置变化后能力失效；投递管线按持久账目停止后续提取。
- 新增 `test/corpus.test.ts` 2 项：规模（≥200、开发≥150、验收≥50）/格式/ID/op 覆盖；fallback 子集由当前规则解析给出同样结果（规则路径缺口如 u002 “这周还有哪些学习块？”标 `rules-gap`，不列入降级保证）。
- 全套 **355/355 通过**（原 337 + 新 18）；`tsc --noEmit` 仅余需 `next typegen` 生成的 `LayoutProps`（既有）；改动文件 eslint 无错。真实 `npm run migrate` 在临时库应用 0030 至 schema30；探测脚本在未配置模型时明确报 `INTEGRATION_UNAVAILABLE`。

### 真实端点能力探测（2026-10-04）

- 主人指定模型 `gemini-3.8-flash-high`（OpenAI 兼容端点，只测此模型），凭证仅以进程环境变量传入、未写文件；在临时库（迁移至 schema30，探测后删除）运行 `probe-model-caps.mts`：**text / jsonSchema（strict json_schema）/ tools（含 role=tool 回填）/ vision 均为 supported**，指纹 `08281fa15a6c8dfe`。
- 同库核对：请求账目 5 条全部 `ok`（每个能力各计一条，含基准与工具回填）；trace 1 条；trace 与 settings 中无 key 片段、无 base64 图片。
- 结论只适用于该模型与该端点；更换模型/端点后旧结论按指纹失效，需重探。生产库未写入探测结果。

### 发布与生产冒烟（2026-10-05 00:05 +08）

- 提交 `d1efca0` 推送 `main`；生产按 [deploy.md](../deploy.md) §4：停桥接 timer 与 web/worker → 备份 `backups/production-20261005-p0-d1efca0`（schema29，sha256 `9b2b8bfd…`）→ 覆盖源码 → 构建 → 迁移 0030 → 启动 → 恢复 timer。回退材料：`/opt/dash-campus-src-95c8cf1.tgz` 与镜像 `dash-campus:rollback-95c8cf1`。停机约 2 分钟。
- 生产源码散列与 `git -c core.autocrlf=false archive d1efca0` 一致（`4995749…`）。
- 冒烟：公网 health `schemaVersion 30`；80 端口 301 到 HTTPS；`/login` 200；`/api/v1/integrations/model-capabilities` GET/POST 与 `/api/v1/ai-budget` 未登录 401；worker 正常启动、恢复扫描 0 项；web 日志无错误。
- 生产真实探测（生产配置同为 `gemini-3.8-flash-high`）：四项 supported，结论写入生产 settings（指纹同本地实测）；账目 5 条 ok、trace 1 条，无 key 片段、无 base64。主人已保存的日额度 1000 保留未被默认值覆盖。
- 未做：登录态网页走查新卡片、生产真实投递经新预算/trace 的端到端（需主人会话，且不写测试数据进生产）。

### 未验证 / 未完成

- 并发测试在单进程内进行；跨进程原子性依赖 SQLite `BEGIN IMMEDIATE`，没有做多进程压测。
- 设置页新卡片没有做登录态网页走查。

## 2026-10-04 易用性修复规格发布（尚未实施）

- 当前交接从 [START-HERE](./START-HERE.md) 和 [STATUS](../STATUS.md) 开始；业务审计基线cbbaeee/schema23，九项失败路径见 [审计摘要](./REPAIR-BASELINE-2026-10-04.md)。
- 新增总修复计划、全业务Agent接口契约和校历/节假日/学校补课规格；确定自研Agent，R0–R5待实施，行为验收E01–E49。
- 197个现有测试通过与隔离/只读审计是此前业务核对。本次只发布文档，没有实现新操作、重复应用测试、迁移数据库或部署。
- 下文阶段“已完成”和旧22/22保留历史口径，不能替代此次真实流程修复或新验收。

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

## R1 共享预算账本与稳定排程（2026-10-04，commit 99d2e7d，未部署）

基线 `f403472`（代码同 `cbbaeee`）。只做了本地实现与隔离行为验证；没有真实网页走查、没有碰生产、Todo 未触及。

### 实现

- **迁移 0024**：`tasks.effort_mode`（deliverable/time_budget，默认 deliverable）、`practice_entries.category`（study/other，默认 study）。`EXPECTED_SCHEMA_VERSION` = 24。
- **单一账本 `dayLedger`**（`workflows/plan.ts`）：页面快照与排程共用。B_day = 已记录实际学习 + 无实际记录的已完成块（估算）+ 进行中/过时未反馈块的已流逝部分（暂占）。同一任务当天有实际记录时其完成块不再另扣（按任务关联，不按分钟相近）；`category=other` 的记录不消耗学习预算。
- **差异重排 `rebuildPlan`**：不再整体 supersede。已开始/锁定/24h 内的块一律保留；24h 外的块仍有效（在可安排窗口内、不越截止、不超任务剩余与当日容量）则保留原 ID/时段，否则才替换。任务已完成/取消/归档时取消其未执行块。无块变化且结论相同不写新批次（snapshotRevision 不变）。受保护块与固定活动重叠时保留并记入 `conflicts`。
- **剩余需求**：估时 − 已确认投入；deliverable 投入达到估时仍未完成时不再自动补排，给出 `needs_remaining_estimate`。
- **截止时刻**：排程使用 `due_at`（instant）或截止日当地次日零点，块结束不晚于截止；窗口不足时放截止前最大片段并报 `missingMinutes`，不改截止。新增原因 `no_contiguous_slot`（预算够但缺连续空档）。
- **快照**：today/week 增加 `fixedMinutes`（无课程语义来源的旧固定活动占用）、`events`（课程/固定活动时间线，与预算同一批区间）、细分预算字段、`conflicts`。
- **intake**：任务/实践/ICS 落库后也触发重排（原先只有课表）。

### 验证证据（隔离行为，固定时钟）

- 新增 `test/ledger-r1.test.ts` 12 项：E05、E07、E08、E09、E10、E11、E13（两种 effortMode）、§4.6 两个具体日案例、重排批次撤销、R0 旧固定活动占用如实展示。`commands-items-v2` 补 U02 断言（真实 intake 管线）。
- 全套 **209/209**，typecheck、eslint 通过。未跑 build，未做网页/真实 provider 验证。

### 仍未做（下一处断点）

- R0：旧课程→课程语义迁移（v1 课表导入未留来源，无法证明的只标 `fixed` 待核对，核对入口未做）；校历/假日/补课映射整体未做；`course_event_exceptions` 仍按标题前缀匹配。
- R1：E06 仅有既有纯函数覆盖；E12 跨午夜/ICS 未补；24h 内超预算的受保护块只保留不提示；未知估时的 25 分钟起步块未做；`effort_mode`/`category`/`dueAt` 还没有命令入口（R2：命令 schema、intake 解析 U03/U04）。
- R2–R5 全部未开始。三页 UI 尚未使用新增的 `events`/`conflicts`/细分预算字段（仅本周页补了未排原因文案）。

## R2 第一段：修改/完成原任务与原文解析（U03/U04，2026-10-04，未部署）

只有本地实现与隔离行为验证；模型假件仅做 task/practice 分类，其余走真实管线。

### 实现

- **`domain/task-text.ts`**（纯函数）：中文时长（一个半小时、两个半小时、1小时20分钟、四十五分钟）；截止解析绝对日期、月日、今天/明天/后天、本周几/下周几 + 钟点（10:00、下午3点、晚上8点半、“上午前”→12:00）；完成表达识别；按名称匹配对象（唯一最优才绑定）。
- **命令**：`create_or_update_task` 带 `taskId` 时修改原任务（只改给出的字段、版本前进、可撤销），新增 `dueLocalTime`、`effortMode`；新增 `complete_task`（走 `updateTask` 记完成时刻并取消提醒，取消未执行学习块，可顺带记实际投入，可撤销）；`record_practice` 支持 `taskId`、`category`。
- **intake**：“做完了”唯一匹配直接完成原任务；同名并列时只问选哪一个（问题键 `task_ref:<itemId>`，回答序号或名称后恢复）；找不到对象按实践保留，不新建同名任务。实践记录按名称唯一匹配关联任务；明显的运动记为 `other`。

### 验证证据（隔离行为）

- 新增 `test/task-text.test.ts` 3 项、`test/task-commands-r2.test.ts` 5 项（E11 截止时刻落库与安排、带 taskId 修改与撤销、完成/取消块/撤销、E14 同名歧义问答、E12 时长与运动分类）。全套 **217/217**，typecheck、eslint 通过。未跑 build，未做网页/真实 provider 验证。

### 已知限制与下一处断点

- 命令路径修改截止只让旧提醒版本失效，不重建提醒；新建任务仍不建提醒（提醒策略属 E23，未做）。撤销任务修改不恢复提醒。
- 运动识别是关键词表；`effortMode` 还没有从原文判定（“本周学两小时”仍按 deliverable）。
- 未做：未知估时的起步块（E14 前半）、自然语言挪块/今晚不学/偏好修改（E15、E25–E27）、通用问答 handler、结果卡与服务端历史（U08）、计时关联（U06）、图片/文件入口（U01）。

## R0–R5 其余部分（2026-10-04，分支 `agentbox/dashcampus`，未推送、未部署）

上面 R1、R2 第一段之后的全部工作。每一包都是**本地实现 + 隔离行为用例**；另做过一次本地网页走查。没有真实模型、没有真实邮件、没有连接生产、Todo 未触及。逐项证据与缺口见 [E01–E49 验收映射](./acceptance-e01-e49.md)。

### 提交与内容

| 提交 | 内容 |
|---|---|
| `7f48e99` | R0/R1 日历层：操作注册表、校历/节假日/补课映射、统一日历解释器 `calendarDay`、时间政策规则。迁移 0025 |
| `a72678c` | R2 学习块/任务操作与统一执行通路（挪动、缩短、暂停、纠正实践、撤销连带重排） |
| `d0cc713` | R2 Agent 闭环：确定性指令解析、绑定器、对话与轮次、通用问答、统一结果。迁移 0026 |
| `7342984` | R2 材料入口：图片课表/校历/调课通知的结构化提取、国家节假日通知确定性解析、来源刷新与退避 |
| `86bc36d` | R2 提醒/摘要策略、身份与通知筛选、状态解释与导出 |
| `e953679`、`d27ea3e` | R2 反馈闭环与 R5 方向：计时关联、卡点排障、目标/试做项目、资料归属。迁移 0027 |
| `02be0cd` | R3 界面：时间线组件、今天/本周/方向三页、统一输入结果卡与服务端历史、`GET /api/v2/calendar-context` |
| `6f965c8` | R4：按样本的估时建议、主动程度与模型预算；E15–E17 用例 |
| `469a3de` | ICS 子集按规格重写；`schedule_session`（在指定时段安排）；E02/E06/E12 用例 |
| `a430326` | XLSX/CSV 本地解析、扫描 PDF 取页面图像走图片识别；空档安排用例 |
| `c4a2442` | `request_review`、`configure_exploration`、`request_owner_digest`、`cancel_operation`、`update_fixed_event` 及自然语言入口 |
| `0ddad0d` | 恢复后收掉过期投递与问题；E22 恢复演练 |
| `81e1fa2` | 新排的块起止对齐到 5 分钟 |
| `7872b1e` | v1 课表导入并入统一操作；v1 任务/记录改动后 worker 自动对账。迁移 0028 |
| `35c96ff` 及其后一次提交 | v1 任务、目标、项目、固定活动表单的写入进同一份变更记录（`workflows/compat.ts`），可从统一入口撤销 |

### 验证证据

- `npm test`：**308/308**（53 个测试文件，独立临时库、固定时钟）。`npm run typecheck`、`npx eslint src test scripts`（0 错误，2 个未使用变量警告）、`npm run build` 通过。
- 本地网页走查（独立开发库、`MODEL_PROTOCOL=fake`、无头浏览器）：`scripts/dev/web-walkthrough.mjs` 全程无页面错误；1440/390/320 三个宽度三页横向溢出为 0；另手工脚本验证了“点固定活动 → 这次不去”“点空档 → 在这里安排”“一句话改固定活动时间”。截图人工看过，未入库。
- 真实来源：gov.cn 2026 年节假日通知网页原文（`test/fixtures/gov-holiday-2026.html`）确定性解析通过。XLSX 样本由 openpyxl 生成（`test/fixtures/timetable-sample.xlsx`，合成内容）。

### 走查与测试中发现并修掉的问题

- ICS 解析把 UTC 时间当本地时间、忽略 TZID、静默丢全天事件 → 按规格重写。
- 取消一份投递后它的问题仍留在待回答列表 → 取消时一并收掉。
- 从备份恢复并解除保持后，恢复前没处理完的投递会永远停在“处理中” → 解除时停止并写明原因。
- 相同课表重复导入每次都换一套新对象并写批次 → 改为无变化。
- 今天预算为 0 时空档仍显示为可安排 → 标“预算已满”；说明文字给出原因。
- 320px 下今天页横向溢出 16px → 修正栅格最小宽度。
- 新排的块落在 14:52、17:41 这类零碎分钟 → 对齐到 5 分钟。

### 与规格不同、或明确没做的

- 真实视觉提取（E01、E40）、真实邮件（E23、E34 的投递）、生产部署、主人七天试用：**没有做**。
- v1 写接口并入了课表导入（统一操作）和任务/目标/项目/固定活动表单（同一份变更记录）；候选/资料/身份规则/可用时间块/设置等表单仍是各自的写法，不写变更记录。
- `correct_extraction`、`configure_source` 没有做成独立操作；读工具没有做成模型可调用的工具；计时沿用专用接口。理由与对应替代见验收映射末尾。
- ICS 全天/跨夜/月重复、旧版 `.xls`、非“一页一图”的扫描 PDF 不支持，会准确说明并保留原件。
- E22 演练在测试进程内完成，没有跑运维脚本的完整进程启停，也没有对真实 Todo 服务演练。

### 下一处断点

配置真实模型 → 用真实课表截图与校历图片跑 E01/E40/E41/E18 并修正；随后真实邮件、部署、主人试用。
