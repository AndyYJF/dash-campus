# Agent 操作范围与接口对齐规格

日期：2026-10-04。状态：待实施，接口变更尚未开发。适用基线：`cbbaeee`，实施前以当前代码重新核对。

**当前阅读说明（2026-10-04）：**下面的`cbbaeee`接口事实是历史基线，大部分R0–R5已实现，当前事实见[STATUS](../STATUS.md)。本轮新增路由、授权、多轮和执行核验修正以[Agent增强v1.1](../../../Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md)为实施入口；本文未冲突的领域/HTTP契约继续有效，不把历史六项操作数量当当前事实。

本文件补充 [修复计划](./REPAIR-PLAN-2026-10-04.md)，将 Agent 从安排时间扩展到工作台主要业务。用户日常通过自然语言表达意图，Agent 获取上下文、问关键问题、选择行动并在授权范围内执行；设置表单保留作纠错和高级入口。

校历导入、国家节假日/调休自动获取和学校教学映射见 [ACADEMIC-CALENDAR-AND-HOLIDAYS.md](./ACADEMIC-CALENDAR-AND-HOLIDAYS.md)，新增验收 E40–E49，继续自研 Agent 路线。

## 1. 当前接口事实与主要断点

经基线源码核对：

- `contracts/commands.ts` 白名单只有 `upsert_course_set`、`record_practice`、`create_or_update_task`、`import_fixed_events`、`apply_event_exception`、`archive_entity` 六项。任务修改语义不完整；停课例外只支持 cancel。
- `POST /api/v2/intakes` 已接受 JSON/multipart；当前实际文件字段为 `files`，不是注释里的 `attachments`。JSON 接收 text/urls/referenceDate，未提供持久对话上下文。
- `POST /api/v2/questions/:id/answers` 有 expectedVersion，但无法解析时只提示“第N周或日期”；通用偏好、对象选择、项目取舍回答需补处理器。
- `POST /api/v2/sessions/:id/:action` 支持 start/complete/skip/lock，直接调用 repository；尚未与统一命令 journal/副作用对齐。
- `POST /api/v2/preferences/confirm` 只是将模板标记 confirmed，不更新具体偏好。
- 目标、项目、身份规则、资料、探索、邮件等已有 v1 路由和领域能力，但没有统一成 Agent 可调用操作。

因此不能只让模型调用现有六种命令就宣称“大多数设置已自动化”。以下均是目标契约，不是已有功能清单。

## 2. 各部分应由 Agent 完成什么

| 部分 | 用户自然语言示例 | Agent 必须完成 | 必要追问/限制 |
|---|---|---|---|
| 身份与通知筛选 | “我是AI专业大一，不用给我研究生专属通知” | 更新已确认身份和有范围的筛选规则；重评估 Dash 待处理通知；明确无关只保留资料 | 不凭兴趣推断资助资格；条件缺失才问；不删除源通知，不回写 Todo |
| 来源接入与资料 | “以后从这个公开栏目收集竞赛信息”“这篇文章归到基线项目” | 检查来源支持能力，接入统一管线；资料关联项目/任务；保留原件和定位 | 没有该来源适配器则说明；不承诺能读取任意群聊；来源内容不成为执行指令 |
| 课表和日常时间 | “这周五的课改到周六”“今晚不学了” | 修改对应事实/单次例外/今日政策，重算受影响计划与提醒 | 真正的课程事实与个人不出席区分；歧义或冲突才问 |
| 校历与节假日 | “导入这份校历，自动获取节假日和调课通知” | 定位/导入校历，获取年度假日与学校通知，维护教学周/补课映射，更新课表预算与提醒 | 国家补班不决定补哪天课；缺教学映射时主动查源/提问；个人假日策略独立 |
| 任务与优先级 | “报告交了”“实验先缓一周”“以后先保证数学” | 完成/暂停/修改对应任务和目标优先级；学习块与剩余需求同步 | 一次暂停不是永久撤销目标；对象不明不新建同名任务 |
| 长短期目标 | “这学期先打好数学基础，科研先尝试” | 更新目标层级、范围、优先级和验证成果；提出有限近期行动 | 目标变化不自动取消所有项目；无法兼容时给取舍建议 |
| 项目探索与投入 | “帮我挑一个能试出是否喜欢科研的小项目”“先试这个两周” | 检索有来源的候选、说明推荐理由；在明确试做授权后建项目、第一步和有限安排 | 试做不等于报名/对外承诺；正式投入仍需明确意图；不编能力/保研概率 |
| 实践与卡点 | “昨天做了一个半小时，没跑通”“其实那次只用了40分钟” | 关联活动、记录/纠正投入与卡点，防重复；调整后续排障与估时建议 | 事实纠正保留历史版本；时长接近不是同一活动 |
| 每周复盘 | “总结这周，帮我决定下周重点” | 汇总有出处的事实、偏差和阻碍，选一个主要重点并安排起步行动 | 没记录就说证据不足；不宣称掌握技能；沿用近期保护和授权范围 |
| 主动程度与调用预算 | “每周找一次项目，没新消息就别问我”“每天最多用这么多模型预算” | 更新允许的触发/周期、成本上限和通知偏好；暂停非必要探索，保留本地查看/修改 | 预算超限说明影响，用户明确改变预算可执行；不能偷偷更换供应商或暴露 key |
| 提醒和邮件 | “工作日晚八点给我摘要，其他只提醒临近截止”“报告提前一天提醒” | 持久更新具体提醒政策和模板偏好，更新相关 jobs；呈现具体变化 | 启用/发送依据明确主人意图；默认只发已配置主人邮箱；不更改密钥或发他人 |
| 纠错与撤销 | “这不是我的任务”“撤销刚才那个修改”“先停止这条处理” | 修正关联/适用性、撤销适用 batch、取消后续未执行操作 | 不抹除来源事实，不覆盖后来修改；已经发送的邮件不能撤回 |
| 导出与运行状态 | “打包我的本周成果”“为什么没提醒我” | 创建既有范围导出并提供下载；解释已知处理/投递状态，给具体恢复选项 | 不输出密钥；unknown 邮件不自动重发；备份恢复/生产部署不由聊天隐式执行 |

所有判断区分来源事实、用户确认、模型建议与执行结果。大部分“调数据”由上述操作承担，而非转成“请前往设置”的回答。

## 3. 统一执行通路

```text
文字/附件/回答/卡片按钮/来源事件
  → intake 或显式动作上下文
  → 结构化意图 + 对象解析 + 相关事实读取
  → 缺口提问或决策（附来源/假设）
  → 白名单操作 + 政策/授权/版本/epoch核对
  → 领域事务 + journal + 持久副作用出队
  → 关联排程/提醒/投影更新
  → 服务端结果 + 三页快照刷新 + 可用撤销
```

一次请求无需把所有工作同步做完。收到材料返回 accepted；只有实际领域变更提交并完成必要投影/排程后才显示对应 updated。邮件 accepted、课程 saved、plan pending 等状态不能合并成一个“完成”。

Agent 是服务端受限编排器，读取结构化事实/定位原文，调用注册操作；不直接读数据库文件、写任意 SQL、执行 shell 或请求任意内部 HTTP URL。资料中“忽略之前规则”等文本仍是资料，不替代主人授权。

对话回答、UI 按钮、兼容 v1 写入都应复用同一领域应用服务。HTTP 适配层负责认证、解析、幂等和返回码；操作注册表负责 schema、对象要求、政策、handler、副作用和撤销类型。避免 UI 调 repository、Agent 调另一条 workflow 各自更新同一状态。

## 4. 操作注册表：需补齐的领域命令

沿用 `contracts/commands.ts` 与 `workflows/commands.ts`，拆分明确领域 handler，不再用兜底分支把未知命令当作任务创建。新 schema、类型、注册操作、执行 handler 与工具描述同步生成或校验，不能分别维护会漂移的白名单。

下列名字是目标接口名，可结合代码作一致命名调整，语义必须保留：

| 操作组 | 注册操作 | 关键参数/处理 |
|---|---|---|
| 身份/筛选 | `update_profile_fact`、`upsert_notice_rule`、`resolve_notice` | 字段或 ruleId；有类型的条件 AST；来源/身份版本；适用状态与理由；历史结束事项不因重评估变新任务 |
| 来源/资料 | `configure_source`、`link_resource`、`correct_extraction` | 支持的 adapterId、限定来源、实体关联；字段纠错/原件定位；主人纠正优先于后续来源同步 |
| 课程/固定事件 | 现有 course/import/exception 扩展，`update_fixed_event` | courseId/occurrenceId、单次/范围、时区；move/cancel；非课程活动也能更新；投影不独立双写 |
| 校历/假日 | `upsert_academic_calendar`、`sync_holiday_calendar`、`apply_teaching_day_override`、`update_calendar_sync_policy` | 学校/人群/学年/年度/来源版本；源教学日→目标日期与mode；有限更新周期；个人假日策略复用 `update_planning_policy` |
| 任务 | 修正 `create_or_update_task`、`complete_task`、`pause_task`、`update_task_priority` | dueUtc/本地表达、effortMode、剩余需求、状态、ID/version；完成/暂停取消或停用相关未来块与提醒 |
| 时间政策/安排 | `update_planning_policy`、`reschedule_session`、`set_session_state` | 暂时覆盖或持久规则；目标日期/窗口；版本和范围；start/complete/skip/lock/unlock 对齐既有动作 |
| 目标/项目 | `upsert_goal`、`set_goal_priority`、`select_candidate`、`update_project_state` | 目标层级、验证成果；试做/正式投入明确区分；项目阶段/暂停/结束及相关任务依赖 |
| 实践/计时 | 扩展 `record_practice`、`correct_practice`、计时 start/pause/stop 操作 | task/session/project/活动关联、实际/定性反馈、卡点；计时核对沿用专用 workflow，结果纳入统一记录 |
| 复盘/探索 | `request_review`、`configure_exploration`、`update_agent_policy` | 时间范围、相关实体、按需/周期、自动化边界、模型成本上限；无新增信息不反复生成方向候选 |
| 提醒/邮件 | `update_reminder_policy`、`update_digest_policy`、`request_owner_digest` | 明确频道、主人地址引用、事件/提前量、频率、quiet、有限模板偏好；不接受任意 HTML/可执行脚本 |
| 恢复/导出 | `archive_entity` 扩展、`undo_batch`、`cancel_operation`、`request_export` | 支持的实体/批次、当前版本、导出范围与原件包含政策；不可撤回副作用明确披露 |

读工具按领域提供 `get_context`、`find_entities`、`get_entity_detail`、`get_budget_and_calendar`、`get_operation_status`、`get_evidence`。必须有界分页/字段过滤，不默认把全部私人历史塞进每次模型请求。

每个操作的注册信息至少包含：输入/输出 schema、需要读取的实体、允许修改字段、来源定位、默认授权级别、scope、版本集合、受影响实体/日期、相关异步副作用、撤销/补偿能力、预算/外部调用上限。由此导出 Agent 工具说明和按钮能力；失败必须显式返回，不静默掉到另一个命令。

模型和前端只接收当前实例已经注册、可执行的 capability。未实现操作不能作为可用工具或按钮提前展示；provider/来源适配缺能力时结果准确说明。来源链接仍需按实际解析目标限制私网/本机访问，不因“用户说接入来源”开放任意内部请求。

## 5. 请求、问答与结果公共契约

### 5.1 意图与执行上下文

用户自然语言保留原文；解释出来的操作另保存：

```text
intent: operation + targets + patch + scope + evidenceRefs + assumptions
context: intake/item/conversation/turn + referenceDate + timezone
serverControl: actor + idempotencyKey + readVersions + policyVersion + instanceEpoch
```

`serverControl` 由认证/服务器设置，不接受模型伪造。已有 `CommandContext` 增加所需上下文与目标版本核对；模型可以输出候选对象，最终绑定 ID 由服务端确认。patch 中缺失表示不改，显式 null 表示允许清空，两者不能混淆。

同一指令拆成多个操作时构建依赖 bundle，明确原子范围。比如“暂停实验，先做报告”不能暂停成功却漏掉报告后仍显示全部完成；跨外部副作用不能假装同一 SQL 事务可全部回滚。

### 5.2 通用问题模型

在现有问题表/接口上增加 purpose/type、目标引用、依赖/读版本、影响范围、建议解释、结构化选项、默认建议、过期条件。至少支持缺事实、对象歧义、临时/持久范围、取舍、授权和实践关联；默认建议不是已提交答案。

保留 `POST /questions/:id/answers` 的 text 与 expectedVersion，可新增 optionId；自由文本交给该问题 purpose 对应解析器。收到回答先持久化，语义可用时恢复依赖；答非所问保留对话并提出更具体问题，不统一报“请回答第N周”。同一缺口不生成重复 open 问题。

直接在统一入口回答时，携带 questionId（点击问题）或 conversation 上下文解析唯一 open 问题；多问题都可匹配时问一次，不拿任意文本补学期锚点。回答所引用实体已变化时核对后重算。

### 5.3 执行结果

统一业务结果包含以下字段；这是目标契约，不覆盖现有响应而导致旧 UI 立即失效：

```text
operationId / intakeId / conversationId / turnId
state: accepted | working | needs_input | applied | partly_applied | no_change | failed | cancelled
summary / decisionReason / evidenceRefs / assumptions
changes[]: entityRef + before/after摘要 + version + detailLink
questions[] / nextActions[] / affectedDates[]
snapshotRevision / followUps[]（如排程更新、提醒更新、邮件投递，各自状态）
undo: available + batchId + 不可逆副作用/冲突说明
error: code + recoverable + 用户可采取的下一步
```

HTTP 202 只表示 accepted，HTTP 200 不能代替领域成功判断。版本过时返回具体冲突，缺身份/对象进入 needs_input，来源资料保存但没有行动显示为资料结果。no_change 不制造 journal/新计划噪音。

异步结果从服务端获取；完成或相关状态变更时刷新对应页面。操作结果与对话引用也纳入导出/恢复，保留必要来源链，不只靠 localStorage。长期对话摘要保留出处与最新版本，不能把过时建议压缩成用户事实。

## 6. HTTP 接口对齐表

当前已有路径继续兼容。下表的“新增/扩展”明确属于待实现设计；具体字段的真相最终由共享 schema 给出。

| 入口 | 基线状态 | 对齐目标 |
|---|---|---|
| `POST /api/v2/intakes` | 已有；JSON和multipart | 新增可选 conversationId、replyToTurnId、questionId、selectedEntityRef；multipart 同名字段，`files` 为标准附件字段；规范化内容摘要用于幂等，同名同大小但不同内容不可误判重试 |
| `GET /api/v2/intakes` | 当前没有列表 GET | 新增服务端分页历史，游标、状态与相关实体过滤；不混同已有 POST |
| `GET /api/v2/intakes/:id` | 已有详情 | 扩展通用结果、实体变化、后续任务状态与撤销引用，兼容旧字段 |
| `GET /api/v2/conversations/:id` | 新增 | 恢复有限分页对话、未答问题和结果；首次 intake 创建会话并返回 ID |
| `GET /api/v2/questions`、`POST /:id/answers` | 已有 | 通用 purpose/option/free text；expectedVersion 保留；答案与恢复任务可靠提交 |
| `POST /api/v2/actions` | 新增 | 只接注册操作与目标版本，供卡片/精简表单调用；与 Agent 共用执行器，不接受任意模型工具名/SQL；异步返回202，同步结果含状态 |
| `POST /api/v2/sessions/:id/:action` | 已有 start/complete/skip/lock | 作为兼容适配转统一操作；补 move/unlock 的明确能力，保留版本与副作用规则 |
| `POST /api/v2/preferences/confirm` | 已有，仅确认模板 | 兼容确认；新增政策修改通过统一 actions/intake，不以 confirm 请求修改所有设置 |
| `POST /api/v2/actions/:batchId/undo` | 已有 | 与自然语言 undo 共用核心流程；batch 和关联异步变更核对一致 |
| `POST /api/v2/intakes/:id/retry`、`cancel` | 已有 | 失败恢复/取消未执行后续；已应用变更使用撤销，不把 cancel 当全面回滚 |
| `GET /api/v2/dashboard`、`week`、`direction` | 已有 | 展示共享快照、变更/问题、可执行动作；引用通用 entityRef/capability，不自行维护业务状态 |
| `GET /api/v2/calendar-context` | 新增 | 指定日期范围的公历日类型、教学阶段/周次、有效课程、来源与同步状态，复用统一日历解释器 |
| v1 profile-rules/inbox/resources/goals/projects/candidates 等 | 已有路径族 | 通过各领域适配进入相同服务与来源/版本/journal；保留兼容响应，不创建第二份对象 |
| v1 settings/ai-budget/digests/notifications/mail/exports 等 | 已有路径族 | 仅已支持设置键映射到操作；外部副作用使用原可靠 workflow；秘密配置不进入模型上下文 |

新增 v2 路由至少复用 `requireOwner`、现有同源/会话约束、幂等机制和 shared schema。模型在进程内调用注册服务，不需要携带浏览器 cookie 调自身 HTTP；前端仍通过认证 HTTP 调同一服务。

## 7. 自动化权限与纠错

- **信息明确且可逆：** 新资料整理、明确主人事实更新、有限起步计划、可调整远期安排可直接执行并给撤销。
- **主人明确指令：** 指定任务完成、偏好修改、今日改期、试做项目、提醒策略变化可直接执行；对象歧义或具体冲突才问，不重复确认同一授权。
- **代理自主取舍：** 在已确认目标与范围内选择具体安排/下一步；改变主要方向或承诺投入要取得相应明确意图。
- **身份筛选：** 本条忽略与长期规则不同。规则只改变 Dash 展示/派生行动，保留来源和“查看被过滤事项/撤销规则”入口；资格不明不能默认过滤重要截止。
- **提醒与来源周期：** 持久授权明确事件、频率、收件范围、quiet、成本上限。自然语言更改产生同版本策略，相关既有 jobs 要更新，不能 UI 改了 worker 仍读旧值。
- **邮件副作用：** 已授权的主人摘要可执行；unknown 投递不可自动重试。修改未来策略可撤销，已发邮件不能撤回，结果必须说明。
- **秘密与基础设施：** Agent 可读脱敏配置状态、协助定位；API key/密码通过安全配置入口写入，不进对话/日志/导出。生产发布、数据库恢复、清空原件不成为普通自然语言配置的隐式副作用。

高级纠错表单不消失，但使用相同操作接口。用户也可看“当前采用了哪些规则”并自然语言撤回，不要求知道内部 policy 名字。

## 8. 数据与实现分包

新增会话/turn、通用问题上下文、作用范围授权/政策、操作记录及必要领域字段，采用向前迁移。复用现有 intake/item/journal/来源表，避免复制另一套任务与课表；外部 jobs 与变更记录关联。导出、恢复与 hold 策略同时覆盖新增数据。

先在 R2 建操作注册表、通用问答和结果契约，交付“身份筛选→通知行动→安排→实践反馈”最小旅程；R3 接 UI/旧接口同路操作，R4 完成时间/提醒/探索政策，R5 完成目标项目与复盘。每个领域依次补 schema、handler、适配、结果/撤销、必要行为测试；不能先列出几十个工具名但无可执行 handler。

审查 `workflows/http.ts` 和旧 routes 当前边界后实施适配，尤其不改变已有可靠投递状态机和 Todo 只读桥接。每次增加命令必须检查 `undo.ts`、导出 allowlist、worker 副作用/恢复，不能单独加模型 prompt。

## 9. 新增行为验收 E30–E39

| ID | 真实流程 | 必须满足 |
|---|---|---|
| E30 | “不推研究生专属通知”，再输入资格不明通知 | 已确认身份/有范围规则生效；资格不明问关键字段；可查看/撤销过滤；Todo/source原文不变 |
| E31 | “数学优先，科研试做两周”，Agent 推荐一个项目后用户选择 | 目标/项目/任务实际关联，生成有限第一步；无需CRUD；不等同对外报名 |
| E32 | 给项目贴资料，再纠正“这段是老师的要求，不是我完成的成果” | 保留定位，修正归属和事实类型；复盘不再当个人成果；来源新revision不覆盖主人纠正 |
| E33 | “昨天学了一个半小时”“刚才那次其实40分钟” | 对象关联正确、实际更新不重复；预算/项目证据一致刷新，可撤销 |
| E34 | “工作日晚八点给摘要，报告提前一天提醒”，随后改为不发摘要 | 策略与既有jobs一致；只发主人；quiet/cost有效；未来取消，已发不可撤回不假称撤销 |
| E35 | Agent 创建任务后从卡片完成；兼容接口再读对象 | 同一实体/服务/版本，journal与提醒同步；无重复任务/并行权威源 |
| E36 | 通用自由文本回答身份/偏好/项目取舍，刷新后继续 | 不要求回答第N周；有限问题、可靠恢复、跨设备引用正确 |
| E37 | 材料含命令文本、模型给未知操作/伪造版本与权限 | 资料不变授权；未知操作显式拒绝，不兜底创建任务；服务端权限与epoch准入有效 |
| E38 | 同名同大小不同附件；同幂等键重试；同句记录不同日期 | 附件内容不误去重；合法重试一次效果；不同意图不全局文字hash合并 |
| E39 | “为什么没提醒”“打包本周成果”“撤销筛选规则” | 返回真实处理/投递解释和可下载导出；无秘密；unknown不盲重发；规则撤销恢复应有派生展示 |

上述全部是待实现验收。共享 schema 类型/单测通过、真实模型行为、真实网页使用与生产部署分别记录，不把文档对齐写成代码已对齐。


## 2026-10-04 模糊时间调整的实现补充

`adjustment_decision` 在现有 intake worker 内读取课程、预算、任务、目标和安排，由模型选择有类型的调整意图或具体问题，不引入任意工具运行时。`agent_clarification` purpose 接受自然语言答案，保存后恢复原投递并读取最新事实。`confirm` purpose 用于推断出的长期规则或具体块/截止修改；未回答时没有领域变更。默认重排未来七天；明确的本周/下周范围由程序核对，超过范围拒绝执行。绑定后的命令继续复用现有注册操作与确定性排程器，HTTP 接口不另起一套。证据与边界见 [决策与发布记录](../flexible-adjustments-2026-10-04.md)。

（2026-10-05 起该工作流更名为 `agent_decide`，见下节。）

## 2026-10-05 目标、修订与自然语言续办（Agent增强 v1.1 P4）

- **目标**（迁移 0031 `agent_goals`/`agent_goal_revisions`，`intakes.goal_id/goal_revision`）：一次主人要求是一个目标；结果后的改口、回答后的续办、“继续这个目标”都在同一目标上提高 revision。目标是业务流程状态，随业务导出与恢复；原话与结果仍在对话与投递里，目标只存修订号、状态（active/awaiting_input/awaiting_confirmation/completed/partial/blocked/cancelled）和服务端核对过的摘要（范围、上一版方案、主人回答过的约束、最近结果、待答问题、已执行批次）。
- **隐式续办**：路由在 `context.currentGoal`（当前对话最近的目标）存在时，可在事项上标 `continuesGoal:true`；服务端据此在那个目标上开新版本，否则新建目标。
- **显式续办**：`POST /api/v2/intakes` 可带 `goalId` 与 `expectedGoalRevision`；目标不存在 404 `GOAL_NOT_FOUND`，版本不一致 409 `STALE_GOAL_REVISION`，两者都不落库。续办回到目标所在的对话。`GET /api/v2/goals?open=1&limit=` 列出最近目标（只读）。
- **旧版本失效**：开新版本时，旧版本还没执行的事项、待答问题、待确认方案与仍在处理的投递一并作废；`executeCommand` 在写入事务内核对投递是不是目标当前版本，不是则返回 `STALE_GOAL_REVISION`，旧模型响应晚到也写不进来。已经生效的修改不自动撤回。
- **“先别做”**：单独一句停止短语（先别做/停一下/取消吧……）在接收时即停止当前目标未执行的部分，不花模型请求；结果如实列出停了几项、哪些已经生效（撤销走原结果的撤销入口）。没有进行中的目标时如实说明。
- **自然语言回答**：会话里有问题在等时，路由可给第五种结果 `{kind:'reply', questionId}`；“第一个/可以/选项原文”这类孤立短答由服务端确定性识别，不调路由。只有一个问题在等就直接作答（序号映射到选项）；多个时具体的选项原文唯一匹配才落位，否则新建 `locate` 问题（候选问题 + “作为新的要求”）先问清；没有问题在等时如实说明，不改数据。回答按原问题的解析规则核对。
- **决策器 `agent_decide`**：可用意图扩展到作息/上限与每对象的挪动、缩短、截止、暂停/恢复、优先、剩余、项目状态、定点安排、建任务、实践（最多 8 个，按步骤执行）；每个意图按自己的日期语义核对（未来安排 31 天内、截止一年内、实践今天及之前 60 天内），明确范围只约束重排/上限/停学；上下文含目标摘要与最近 10 轮对话（总量封顶 20k 字符）；同一目标上一版的范围在这一版没说范围时沿用。
- **结果视图**新增 `goal: {id, revision, intakeRevision, current, state, objective}`；`current=false` 表示目标已被改口或停止，这一轮不再是最新。

## 2026-10-05 执行后核验与有限修正（Agent增强 v1.1 P5）

- **核验记录**（迁移 0032 `agent_verifications`，随业务导出/恢复）：每次投递处理完已执行的部分后，服务端按 `OPERATIONS[cmd].verify` 读回实际数据逐项核对，一轮一行（`round` 递增，`UNIQUE(intake_id, round)`）。检查项：`read_only`（查看不得产生批次）、`applied_once`（同一事项至多一个业务批次）、`entity_state_matches`/`policy_saved`（写入字段读回一致；之后又被改过只核对存在）、`session_in_scope`、`plan_consistent`（重排已跑且未失败；暂停/完成的任务不再占未开始的块；不撞课程/固定日程）、`practice_not_duplicated`、`side_effect_status`（邮件只核对已交给投递，不核对收件，不自动重发）、`dependent_steps_completed`（多步时任何一步没完成即不通过）、`demand_covered`（截止前排不下）。模型看不到也不能改这些判断。
- **状态**：`verified` 全部通过；`partial` 有不通过且无现成问题；`needs_action` 不通过项都对应一个待主人取舍的问题（截止前排不下、锁定块撞课）；`blocked` 自动修正用尽或同一失败重复；`pending` 还有步骤在等回答。目标状态随之为 completed / partial / awaiting_input / blocked。
- **有限修正**（`workflows/agent-run.ts`）：只做确定性动作——`replan`（在原范围内重跑排程）与 `rebind`（对象版本已变时按最新状态重新绑定并执行），不调模型、不扩大范围、不提高预算。每个投递至多 2 次修正、每次至多 4 步；不通过项的指纹与上一轮相同即停止；投递累计主动执行时间（`intakes.active_ms`）到 180 秒也停止。修正决定先写入核验行再执行。
- **步骤幂等**：`executeCommand` 在写入事务内发现同一 `item_id` + 命令已有批次时直接返回原批次（`replayed: true`），不再写第二次；worker 崩溃恢复后不会重复记实践、建任务或发邮件。
- **结果视图**新增 `verification: {status, label, checks[{kind, ok, subject, detail}], repairs[{reason, steps[]}]} | null`；`partial`/`blocked` 时 `state` 为 `partly_applied`，`needs_action` 且取舍问题未答时为 `needs_input`，核验涉及的问题并入 `questions`，摘要追加“核对未通过：…/需要你决定：…”。全部查看时 `label` 为“只查看，没有改动任何东西”。目标摘要新增 `verification: {status, failing[]}`。

## 2026-10-05 试用指标（Agent增强 v1.1 P6）

`GET /api/v2/agent-metrics?days=7`（仅主人，`days` 1–30，按实例时区的当地日期）返回 `metrics`：`window`、`intakes`（统一栏投递）、`routing {model, rules, fast, other, fallbackReasons}`、`asking {intakesAsked, rate, byPurpose}`、`feedback {total, byVerdict}`、`outcomes {verified, partial, needs_action, blocked, pending, unverified, failed, cancelled}`、`repairs {total, intakes, stoppedByLimit}`、`daily[{date, requests, errors, decisions, p50Ms, p95Ms}]`、`notes[]`。只读聚合已有表，不写库、不调模型；样本为 0 时比例为 `null`，`notes` 说明样本量与缺失数据的含义。

## 2026-10-05 语义修复：约束、统一门、确认快照、步骤凭据（迁移 0033）

任务见 [语义修复提示词](../../../Plan/dash-campus-AGENT-SEMANTIC-REPAIR-PROMPT-2026-10-05.md)，逐项证据见 [语义修复验收](./acceptance-semantic-repair-2026-10-05.md)。迁移 **0033**（schema 32 → 33，向前新增，不改已部署迁移）。HTTP 路由与请求体不变；结果视图只新增字段。

- **目标约束**（`agent_goal_constraints`，`src/domain/constraints.ts` 的 zod 判别联合）：`date_scope {dateFrom, dateTo}`、`protect_days {days: weekend|workday}`、`protect_dates {dateFrom, dateTo}`、`protect_entity {ref}`、`no_study_after {time, days}`（表的 CHECK 预留了 `note`，当前不产生）。路由/决策只能**提出**候选（每条带 `excerpt`）；服务端只接受引用逐字出现在主人原话或回答里的候选（`source = owner_text | owner_answer | rule_parse`），资料、工具结果、模型理由里的“已确认/可以解除”不入库。解除（`release`）同样要主人原话。范围类以最新一版为准；保护类跨版本保留直到主人明说解除。
- **同一对话沿用**：被理解成新的一件事时，新目标沿用同一对话上一件事（12 小时内）仍生效的**保护类**约束（`source = inherited`，引用保持主人原话）；范围与“几点后不排”会生成新规则，不沿用。主人这次的明确要求只和沿用来的保护冲突时，不替主人拒绝，改为确认（问题里写“和你前面说过的条件冲突……确认就只在这一步不按那条执行”）；同意只对这一步有效。
- **统一门**（`src/workflows/agent-gate.ts` 的 `gateCommand`）：路由 act、决策、回答续办、按钮、恢复与修正绑定出的命令都先过门：日期有效、先限跨度再展开、与主人范围求交（越界拒绝）、按保护约束收窄（重排/临时规则避开受保护日子，`notes` 写明）或拒绝（改“每天都生效”的设置会连带受保护日子、挪受保护对象、约束把要做的事全部裁掉）。拒绝的事项 `evidence.code = "GATE_REJECTED"`，不落库。
- **作息能力**：`window_end`/`window_start` 意图新增 `days: all|workday|weekend`（缺省 all），只改对应模板。
- **完整回答**：确认问题的回答只有完整、无附加内容的同意/拒绝（`completeVerdict`）零模型处理；其余（条件、疑问、指代、改口）作为修订：同一目标开新版本、旧方案作废，整句与原方案一起交给决策。带条件的回答得出与上一版完全相同的方案时，不执行，重新确认并写明“没有改变这份方案”。
- **确认快照**：确认问题的指纹 = 过门后的规范化命令 + 相关事实（作息单例、相关规则、对象版本，`command-facts.ts`）+ 范围与保护约束键（`gateKey`）；问题正文写实际修改（对象、修改前后、长期/临时、保护项、不能撤销或会发邮件）。确认后执行事务内再核对事实，变了返回 `STALE_FACTS`，重读并说明差异后重问（`staleReconfirms` 计数）；无关变化不重问。
- **步骤凭据**（`agent_step_executions`，主键 `(item_id, command)`）：与领域写入/入队同一事务提交，`batch_id` 记变更批次，`effects_json` 记异步/产物引用（`job`、`exploration_run`、`review`、`export`；邮件经 job 关联现有投递状态机）。恢复重跑按凭据返回原结果（`replayed`），不再产生第二次副作用；主人新的要求是新事项、新凭据。
- **异步核验**：`side_effect_status` 按凭据里的引用读真实状态：排队/进行中 → `ok: null`（核验 `pending`），失败/取消 → 不通过，完成按产物判断；邮件只核对到“服务器已接收”，`unknown` 不自动重发。后台任务结束时 worker 调 `reverifyAfterJob` 重新核验并更新目标状态，不轮询。新增检查 `constraints_hold`：主人说过不动的部分执行前后的事实指纹必须一致。没有主批次时也核对必要后续（要求的重排失败或缺失 → 不通过并可修正）。
- **修正**：`replan` 修正带原 `replanDates` 与保护条件重跑，不退化成全局重算。
- **结果视图**：`goal.constraints: string[]`（例：“周末的作息、规则和安排不动（你说“周末别动”）”，沿用的写“沿用你前面说的”）。
- **计时口径**：`modelMs` 只统计模型 HTTP 时间。单份投递 180 秒上限按主动执行时间 `intakes.active_ms`（迁移 0034）计：worker 处理这份投递的实际时间（模型、查询、执行、核验与修正），模型调用后与处理结束时记检查点；不含排队与等主人回答。用完后不再请求模型，已完成的结果保留；每次模型调用的超时不超过剩余时间。进程崩溃最多丢最后一段未记下的时间。
- **指标**：`metrics.stages {understandFailed, clarified, confirmed, scopeRejected, staleReconfirmed, execFailed, asyncWaiting, verified, partial, repaired, ownerCorrected}`、`metrics.modelTime {p50Ms, p95Ms, maxMs}`（单份投递的模型 HTTP 耗时）与 `metrics.activeTime {p50Ms, p95Ms, maxMs, samples}`（单份投递的主动执行时间；0034 之前的投递没有记录，不补算）。
- **解除约束**：模型给的 `release` 只是候选。服务端按类型与点名字段（`days`/`dateFrom`/`dateTo`/`time`/`ref`）匹配到目标上具体的约束 ID（只匹配当前版本及以前的），确认问题点名要解除哪条；主人确认后记 `releaseAuthorized {ids, revision}`，目标版本变了即失效；该步执行成功后才把这些约束改为 `released`。不确认就仍按原约束过门。
- **具体学习块的条件**：`GateContext.statedScope` 是主人明说的日期范围（`date_scope` 约束）。`schedule_session`/`reschedule_session` 按实际日期与起止时间核对 `statedScope` 与 `no_study_after`，越界即拒绝；核验项 `goal_conditions_hold` 从目标上生效的约束读回本批写入且仍在原位的学习块。
- **对象身份**：`commandEntities(command)` 统一解析命令点名的对象（固定对象字段 + 通用 `entityKind/entityId`），确认快照与 `protect_entity` 核对共用。
- **结果状态**：新增 `in_background`——核验在等后台任务、而本身已写入或无需写入时使用；此时目标保持 `active`，后台结束后重新核验再定终态。
- **指代不明**：带条件的回答新增了 `protect_entity`、方案却与上一版一模一样时，问题 `purpose: "tradeoff"`、`fieldPath: "adjustment.referent"`，选项为方案里动到已有对象的每一步 +“都不是，其余照这份方案执行”+“先不要，什么都不改”；回答 `{choice}`。指认某一步 → 对该对象记 `protect_entity`（id 引用，摘录为主人那句回答）并去掉这一步再确认；选“都不是”且方案指纹未变 → 视同确认。

## 2026-10-05 过期未反馈的学习块（不迁移）

问题：已经结束、仍是 `planned/tentative/in_progress` 的块不在“在途”查询里，也不算投入，重排把需求按完整估时重新补排（生产实例：用户指定 08:00–09:00 过去后，一次取消课程的重排又排了 10:20–11:20）。

- **判定**（`awaitingFeedbackSessions`，`src/workflows/plan.ts`）：块已结束（`end_utc <= asOf`）、状态仍为计划/进行中、任务未结束未归档。排程、提问、页面共用这一份。
- **排程**：这类块的分钟数**挂住**同一任务的需求——不算投入（`spentMinutes` 不变），也不当作没做；新增需要 = 剩余需求 − 在途块 − 挂住分钟。仍有缺口被挂住时，未排列表给 `reason: "awaiting_feedback"`（`missingMinutes` = 被挂住的部分）。共享账本照旧把已过去的部分算作暂占，不转成实际投入。
- **问题**：每段一个持久问题，`purpose: "session_feedback"`、`fieldPath: "session.feedback"`、`questionKey = session.feedback:{sessionId}:{endUtc}`（刷新、重排、重试复用；块被挪走后再过期才是新问题）；`context {sessionId, taskId, plannedMinutes, startUtc, endUtc}`。同一任务同时只问一段，最多 3 个同时在问，不占其他问题的 3 个名额。块已有结果（别处记过、挪走、任务结束）时收回。重排后（`raisePlanQuestions`）与 worker 每轮都会检查。
- **回答**：选项“做完了，这件事也完了 / 这段做完了，事情还没完 / 没做，帮我另排”，也可自然语言（输入栏点“回答”或问题接口）。解析结果 `{outcome, actualMinutes?, remainingMinutes?}`，只记主人说出口的分钟数；只说“没做完”或只给一个数会追问。落实走现有操作与统一门：`task_done` → `set_session_state complete` + `complete_task`；`session_done` → `complete`；`skipped` → `skip`（历史保留，重排按原需求再排一次）；`partial` → `complete`（带 `actualMinutes` 时写一条关联实践）+ 有剩余时 `create_or_update_task remainingMinutes`。只说“做完了”没说范围时：这段是该任务唯一的在途块、且剩余需求不超过这段才算整件事完成，否则只记这一段。落实前重读块状态，已有结果就不再写。
- **剩余报告的时刻**：`remaining_reported_at` 之后的投入才从报告的剩余里扣，同一时刻记下的投入算在报告里（`>` 而非 `>=`），避免“做了 40、还剩 30”被扣成 0。
- **主人另加一段**：`schedule_session` 照常允许；同一任务有待反馈块时，结果写明“之前 … 那段还没记录做没做，仍等你反馈，这段是另加的”。`reschedule_session` 挪过期块是原地移动（ID 不变，原因写“原 …”），对应问题随之收回。
- **结果视图**：学习块新增 `awaitingFeedback: boolean`；时间轴标“待反馈”，详情页说明“没说之前不算完成，也不会整段补排”，按钮为“这一段完成 / 没做，另排 / 挪到…”。
## 2026-10-05 反馈记账补充

`session_feedback` 回答中的 actualMinutes 不得由计划时长或完成比例推算。仅有“完成一半”时保留待答问题并追问；明确 remainingMinutes 可单独更新剩余。`set_session_state complete` 写入的实践使用已有 plan_session_id，需求抵扣只替代对应块；同日其他完成块不能被这条实际记录覆盖。无实际分钟的完成块只参与需求估算，不生成实际投入。无 schema/API 变更。

## 2026-10-05 截止日与范围的歧义（无迁移）

问题：“概率论大作业明天就要交了，帮我优先安排”里的“明天”是截止，不是“只动明天”的范围；原来模型或文字解析把它记成单日 `date_scope`，从今天起的重排被统一门以“超出了你说的范围”拒绝。

- **判定**：`deadlineScopeAmbiguity`（`src/workflows/intake.ts`）。只在本轮意图含 `replan`/`schedule_at` 时检查；截止日来自本轮 `set_due`、`create_task.dueLocalDate`，以及 `prioritize`/`schedule_at` 点名的现有任务的截止。候选范围只取主人原话（文字解析的单日、主人原文摘录的单日 `date_scope`、单日 `decisionScope`）。某个候选日 D 晚于今天且正是某件事的截止 → 有歧义。主人回答里已说范围、或主人说的范围从今天覆盖到截止，都不问。
- **问题**：`purpose: "tradeoff"`，`fieldPath: "adjustment.scope"`，`questionKey = scope-choice:{itemId}:{D}`；提示“你说的 M/D 是「任务」的截止日。这次安排是从今天到截止前都可以排，还是只调整 M/D 那一天？”，选项“从今天到截止前都可以排 / 只调整 M/D 那一天 / 先不要，什么都不改”。问在统一门与确认之前；决策路径答后重新决策，命令路径答后再走原步骤。
- **回答**：`{choice}` 结构化处理，不交给模型二次理解。0 → `scopeChoice {date: D, mode: "deadline"}`：D 不再算范围（`decisionScope` 的 `notScope`、主人原文的单日 `date_scope` 去掉、不记到目标约束），默认范围与其他已说的范围照常生效；1 → `mode: "only"`，范围固定为 [D, D]；2 → 不执行，结果“按你说的先不改，原来的安排没有动”。同一项只问一次。
