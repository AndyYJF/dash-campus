# Agent 操作范围与接口对齐规格

日期：2026-10-04。状态：待实施，接口变更尚未开发。适用基线：`cbbaeee`，实施前以当前代码重新核对。

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
