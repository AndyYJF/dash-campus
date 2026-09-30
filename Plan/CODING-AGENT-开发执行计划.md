# Coding Agent 开发执行计划 v1.2

日期：2026-09-28。对象：接手实现的 Coding Agent。状态：开发规范，尚未实现或实测。与 [完整产品与开发计划 v1.2](./完整产品与开发计划-v1.2.md) 配套；A 首页布局已由用户选择。

## 0. 接手指令与执行边界

实现一个每人独立部署的单用户学习与职业探索工作台。主流程是身份筛选 → 学习与项目安排 → 实践记录 → 有依据的复盘调整；支持按需与定期搜索，使用主人自己的模型 API，邮件通知，Web 首发。

用户确认的是上述目标和边界；本文中的技术选择、数值和流程裁决是本轮为消除歧义设定的**实施默认值**，不是额外向用户索取的承诺。普通开发决策按本文执行，外部凭证和部署授权缺失才阻塞相应外部验证。

本产品应在独立项目根目录实现。不要把代码放进当前 andy-blog，不修改博客数据库或生产服务。接手任务未给目标目录时，只先询问目标目录；本文可独立用于新的项目会话。

Windows 命令使用 Git Bash，命令先写入脚本再执行；删除使用明确字面路径，不使用 `$` 等变量拼接删除对象。没有要求时不提交、推送或发布。不得把密钥、真实群聊或个人资料作为提交的演示数据。

### 文档优先级

用户后续明确要求 > 本文业务执行契约；UI 呈现以完整产品计划 v1.2 第 5 节及本文第 13 节为准。v1.1 及更早文件只作历史记录。遇到未约定的小问题，选择最小实现并记录在 docs/decisions.md；不得默默扩大为多用户 SaaS、复杂自动排程或无限运行的 Agent。

## 1. 冻结的实现基线

| 项目 | 实施默认 |
| --- | --- |
| 应用 | TypeScript + Next.js，普通 Node 部署；使用实施当天受支持的兼容稳定版本并提交 lockfile |
| 数据 | better-sqlite3 驱动、显式 SQL migrations、repository 层；同机本地 SQLite WAL |
| 校验 | Zod schema，前后端共用业务契约；模型输出也必须校验 |
| 样式 | CSS Modules + CSS 变量；A 紧凑布局，首版随系统亮暗并验证手机；手动主题选择后续 |
| 后台 | 同库 Node worker；一个实例一个 worker，数据库持久 job，不依赖浏览器定时器 |
| 模型 | ModelProvider 窄接口；只接通一种经用户端点验证的协议，不假定 key 自动支持联网或工具调用 |
| 搜索 | 首个真实适配器为 Tavily Search + Extract HTTP API；没有 key 时只用显式 fixture 或粘贴资料，不声称联网完成 |
| 邮件 | Nodemailer SMTP；一个主人收件地址，HTML 固定布局 + 可配置栏目 + 纯文本 |
| 部署 | 一个镜像两个命令：web、worker；Docker Compose；数据卷不公开 |
| 测试 | Node test runner/项目兼容测试工具做关键规则与集成测试，Playwright 走核心 UI；不创建重复检查全集 |

暂不引入 ORM、Redis、向量数据库、微服务或多 Agent 编排。若出现明确技术阻碍，记录原因及最小替代，而不是为了“扩展性”提前增加组件。

### 必须交付 / 后续

- V1：任务与周视图；基本目标项目；三值身份筛选；按需和定期搜索；实践模板；日志与复盘提案；邮件；草稿；导出；备份恢复。
- V1 限定：课程仅手动固定时间段，不自动读学校系统；成果只支持文本与链接，不实现文件附件；助手只支持当前项目/当前周的有限上下文请求；不做无限聊天历史。
- 后续：Android、桌面小组件、完整离线、拖拽甘特图、任意 HTML 模板编辑器、文件知识库与 OCR、多模型路由、通用自主 Agent。
- 现有 Todo 的复用与数据迁移是独立兼容任务。核心新系统不以拿到旧源码为前提；未验证迁移前保留旧系统，不宣称新平台已完全替代现有使用。

## 2. 开工顺序与真实依赖

| 任务 | 依赖 | 要产出的东西 | 完成判据 |
| --- | --- | --- | --- |
| T0 项目与依赖 | 目标目录 | 脚手架、lockfile、环境占位符、配置 schema、适配器接口、fixture 约定 | 本地可启动；缺模型/SMTP/search 时基础功能可用且显示未配置 |
| T1 数据与身份 | T0 | migrations、唯一主人、登录退出、版本与幂等共用组件、目标项目任务基础 | 重启保留数据；未登录不能读数据；第二主人无法创建；冲突返回 409 |
| T2 最小执行闭环 | T1 | 今日、任务 CRUD、项目详情、日志、成果链接、周视图、提案骨架 | 手工项目→任务→记录→成果可走通；原子应用一个改期提案 |
| T3 持久任务与邮件 | T1,T2 | job leases、提醒版本、邮件状态、模板预览、普通邮件 | worker 重启可恢复；改期边界行为符合第 8 节；AI 关闭仍能提醒 |
| T4 收件箱 | T1,T2,T3 | import schema、source revisions、条件 AST、纠正和任务草案 | 第 11 节 F1–F5 输入得到固定结果；新来源版本不覆盖用户任务 |
| T5 探索与实践 | T1,T2,T3 | Model/Search 真实适配器、方向卡、实践模板、定期探索、来源证据 | 搜索→候选→项目→具体任务可运行；无条件数据不伪装适合 |
| T6 复盘与主动建议 | T2,T3,T5 | 周记录查询、草稿、独立提案、反馈规则、预算 | 卡点→带依据建议→确认→更新计划；没有记录时输出资料不足 |
| T7 自部署交付 | T3–T6 | 草稿补交、导出、备份恢复、Compose、迁移说明、移动 QA | 干净实例安装及恢复；网页全部核心路径；真实集成状态单列 |
| T8 旧工具兼容 | T2,T4；旧格式可读 | 旧 Todo 导出映射、插件 bridge、dry-run 报告 | 重复导入不重复创建，旧数据数量/时间/状态/关系核对；否则明确未接通 |

提案与日志在 T2 建立，不能拖到“AI 最后阶段”，因为探索项目和周计划已经依赖它们。T5 搜索、SMTP 或模型凭证缺失时可用 fixture 完成本地工程，但对应真实集成不能打勾。

每完成一项，更新 docs/progress.md：完成行为、验证方式、剩余问题。不要每个小改动跑全项目或等待用户批准常规实现。

## 3. 配置、接口与工程目录

建议目录：src/app、src/domain、src/contracts、src/repositories、src/workflows、src/integrations、src/worker、migrations、scripts、fixtures、docs。业务方法由 API 与 worker 共用，UI 不直连数据库。

配置名字固定：APP_BASE_URL、APP_TIMEZONE（默认 Asia/Shanghai）、DATABASE_PATH、SETUP_TOKEN、MODEL_PROTOCOL、MODEL_ENDPOINT、MODEL_NAME、MODEL_API_KEY、SEARCH_PROVIDER、TAVILY_API_KEY、SMTP_HOST、SMTP_PORT、SMTP_TLS_MODE、SMTP_USER、SMTP_PASSWORD、MAIL_FROM、MAIL_TO。

secret 来自服务端环境变量或只读文件，前端只显示 configured/not_configured/error。非敏感设置保存在数据库。模型与邮件端点是显式部署配置，和任意网页 URL 抓取的网络权限分开。

ModelProvider：输入 {workflow, context, outputSchemaVersion, timeoutMs}，返回 {validatedResult, usage?, providerRequestId?} 或结构化错误。不能返回未校验的可执行操作。未知协议在 T0 记录实际缺口，使用 FakeModelProvider 继续本地工作，不私自猜测请求路径。

SearchProvider：search({query,maxResults,signal}) → SearchHit[]；extract({urls,signal}) → EvidenceDocument[]。生产首个适配器调用 Tavily 的 /search 与 /extract；搜索结果的摘要标记 snippet，Extract 成功且有文本标记 retrieved，资格事实仍需引用原文。接口依据：[Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)、[Extract](https://docs.tavily.com/documentation/api-reference/endpoint/extract)。这是选型默认，不代表用户已有该服务或已同意购买。

默认无需自行运行任意网页抓取器。没有 Extract 配置时允许用户粘贴原文；粘贴来源标记 user_supplied。抓取失败不自动退回到有内网访问能力的通用 fetch。

## 4. 最小领域契约

ID 使用 UUID；UTC 时刻存 ISO 8601；所有可变业务对象有整数 version，从 1 递增。删除以 archived_at 软删除，日志和证据引用不级联消失。

### 4.1 核心对象

```ts
type Due =
  | { kind: 'none' }
  | { kind: 'date'; localDate: string; timezone: string }
  | { kind: 'instant'; at: string; timezone: string };

type Task = {
  id: string; title: string; description: string;
  projectId: string | null; goalId: string | null;
  status: 'todo'|'doing'|'blocked'|'done'|'cancelled';
  priority: 'normal'|'high'; estimateMinutes: number | null;
  plannedWeek: { localMonday: string; timezone: string } | null;
  scheduledStart: string | null; scheduledEnd: string | null;
  due: Due; version: number; reminderRevision: number;
  archivedAt: string | null;
};

type DailyLogInput = {
  clientEntryId: string; occurredOn: string;
  progress: string; blocker: string;
  taskId?: string; projectId?: string;
};

type ProposalOperation =
  | { kind:'create_task'; clientRef:string; input: Omit<Task,'id'|'version'|'reminderRevision'|'archivedAt'> }
  | { kind:'reschedule_task'; taskId:string; expectedVersion:number;
      scheduledStart:string|null; scheduledEnd:string|null }
  | { kind:'set_task_status'; taskId:string; expectedVersion:number; status:Task['status'] };
```

create_task 的 reminderRevision 由服务端生成，模型不能设置。调整已有 due 不在首版 AI 操作集合内；主人手动改期走普通任务 API。创建项目由用户在候选详情明确点击并编辑后提交，AI 只提供项目草案。

Goal：id/title/reason/horizon(long_term|semester)/status(active|paused|completed)/version。Project：id/title/question/expectedOutcome/prerequisites/reviewQuestions/status/goalIds/version。Candidate 和 PracticeTemplate 见第 7 节。

Log 采用新增记录，编辑作为在线修订；clientEntryId 在实例内唯一，同 ID 不同正文为 409。成果为 Artifact(id,projectId,logId?,kind:text|link,title,body,url?,version)，URL 限 http/https，不执行内容。

### 4.2 必须建表的关系和唯一约束

| 表组 | 约束 |
| --- | --- |
| owner, sessions | owner.id 固定为 1，数据库 CHECK/PK 强制唯一；session 保存 token 摘要和到期时间 |
| goals, projects, project_goals, tasks | 外键启用；project_goals 联合唯一；任务可不属于项目 |
| profile_facts, profile_rules | 明确字段和值及来源；规则必须主人启用，保存 scope 和 version |
| availability_blocks, fixed_events | 周可用窗口与固定事件；事件实例使用开始/结束时刻 |
| daily_logs, artifacts | client_entry_id UNIQUE；关联归档对象仍保留 |
| inbox_sources, inbox_revisions | (source,external_id) 唯一逻辑消息；(message_id,revision_key) 唯一版本 |
| inbox_decisions, inbox_task_links | 决策关联具体 revision、规则版本；(message_id,action_key) 唯一自动任务关联 |
| exploration_topics, exploration_runs, evidence_documents, candidates | run 关联 topic 或手动请求；candidate 有 canonical_url 和 evidence_hash；原文版本不可变 |
| proposal_groups, proposals, proposal_operations | group 只是展示集合；每 proposal 原子应用；input_versions_json 保存读集 |
| reviews, review_edits | 同周期允许草案修订；原事实引用保留，主人编辑与 AI 草案分开 |
| jobs, notifications, deliveries | jobs.dedupe_key UNIQUE；delivery 有 request_id、lease_token、payload_snapshot 与状态 |
| idempotency_keys, activity_events, settings | (actor_scope,route,key) UNIQUE，记录 request_hash 与完成资源；settings 键唯一 |

migrations 必须创建外键、CHECK 和索引，不能只靠 TypeScript 类型约束。payload JSON 由 schema 校验，查询频繁的状态、时间、关联 ID 使用独立列。

### 4.3 时间与周负担

date 截止在 UI 显示“某日截止，具体时间未知”。为判断逾期，内部以该日期在指定时区的下一天 00:00 为边界，但不把这个内部边界显示成来源事实。日期型提醒默认本日 09:00；精确时刻型由用户选提前量，默认 24 小时；导入时已过提醒点不立即补发，进入今日待处理。

周安排以 plannedWeek 为归属，未排具体时段也可指定本周；只填写截止不自动占用某周容量。排到具体时段时，在同一事务按该任务规划时区更新 plannedWeek，周视图单独列出尚未安排的临近截止任务。

整周承诺负担 = 归属该周且非 cancelled 的任务 estimateMinutes 总和，含已完成任务；未知估时单列。整周可用分钟 = 整周可用窗口并集扣固定事件后 × 0.8。另算“剩余未完成负担”和“从当前时刻到周末的可用分钟”，后者只用未来窗口并同样预留20%缓冲，不再次利用过去空闲。

剩余负担包括本周所有 todo/doing/blocked 的全额估时（含计划时段已过去但未完成项），V1 没有实际计时，doing 按全额是保守估计且明确标注。无时间数据时仅显示任务与已知估时，不显示安排合理或可再投入多少。20%为可修改默认，用户明确安排在缓冲内时显示超预算并允许确认，不声称物理时间冲突。

V1 排程由主人指定任务时间段；AI 可给任务拆解和调时草案，程序检查重叠、固定事件和可用窗口。冲突需修改或主人显式覆盖并记录原因；不开发自动寻找全局最优时间表。

固定课程/活动：title、weekday(1–7)、localStart、localEnd、timezone、validFrom、validUntil；单次事件用 date 和起止时间。V1 每周重复只支持同日开始结束，跨日拆成两条；例外表支持某日取消或替换。生成每周窗口时先合并可用区间，再扣固定事件，防重叠重复计数。

使用维护中的时区库将当地时间转换为 UTC；不存在的夏令时时刻向后移到第一个有效时刻，重复时刻取较早偏移，并在该 occurrence 标记调整。实例显示时区改变不移动 instant/date 的原时区语义；周期时区修改需要确认，仅重建未来 occurrence。每个 occurrence 唯一键包含规则 ID、规则版本、当地日期和选择的偏移。

## 5. 通知输入、纠正和来源更新

### 5.1 导入 envelope

```ts
type NoticeImport = {
  schemaVersion: 1;
  source: string;         // 主人配置的持久来源标识，不能随插件重启更换
  externalId: string;     // 来源内稳定消息 ID
  revisionKey: string;    // 修订 ID 或正文 hash
  revisionOrder: number | null; // 仅当来源保证单调顺序时填写
  occurredAt: string;
  text: string;
  sourceUrl?: string;
};
```

同 revisionKey 同正文重复到达返回既有资源；同 key 不同正文返回 409 SOURCE_REVISION_COLLISION。r1→r2→r1，current 不回退；不可排序且内容不同的新版本存为 revision_conflict 待主人选择，不按网络抵达时间猜新旧。导入 token 只能向配置允许的 source 写入。

第一次生成行动后固定 action_key，不由每次模型提取随机生成。一条通知默认一项行动；多项行动首次提取后由主人确认并编号。新修订涉及行动变化时展示差异，选择保留、更新或新建，不能重新提取就自动复制整套任务。

正式任务一旦建成，来源更新永不自动覆盖其 title、due、status、schedule。只标记来源变化和生成差异草案；主人在人工编辑表单确认后调用 PATCH /tasks/:id，携带 expectedVersion 与 sourceRevisionId，可更新 title/due 并记录来源版本，同时更新提醒。这条人工编辑路径不同于 AI proposal，后者仍不得修改已有 due。资格变更只提示，不自动取消已确认任务。

### 5.2 筛选计算与纠正作用域

模型输出有依据的条件树，程序三值计算：TRUE/FALSE/UNKNOWN。叶子只能是允许的身份字段与 eq/in 比较，附原文引用；未填写的字段为 UNKNOWN，原文含糊或没有证据的条件为 UNKNOWN。

- all：任一 FALSE 则 FALSE，全 TRUE 才 TRUE，其余 UNKNOWN。
- any：任一 TRUE 则 TRUE，全 FALSE 才 FALSE，其余 UNKNOWN。
- 不支持的比较条件保持 UNKNOWN，不凭模型分数折叠。

判断结果单独存 applicability；处理分区为 action/info/opportunity/review/folded，二者独立。明确 TRUE 且行动必需进入 action；自愿参与进入 opportunity；FALSE 可 folded；UNKNOWN 进入 review。未配置模型时可手填条件或仅存原文，不假装语义筛选已运行。

纠正 UI 提供三个不同操作，默认第一个：

1. 仅本条：当前修订的分区覆盖，例如不参加本次活动；不改变兴趣或身份。
2. 更正身份：修改主人确认事实，受影响判断变成待重评；不回写已确认任务。
3. 保存规则：明确 source、通知类型、结构化条件和输出，预览影响后启用，可撤销。

同一修订人工覆盖优先；其次匹配的人工规则（显式 priority，冲突则 review）；再由已确认身份评估条件树；最后只保留模型解释。人工规则可改变分区，但“资格不符”不能仅来自个人不想参加的偏好。源修订变化后旧人工覆盖保留历史，当前版需重评。

## 6. 提案、反馈与主动触发

V1 不实现一份提案内部的任意部分操作选择。每一份独立建议是一份原子 proposal；一个 review 可展示多份 proposal，用户逐份接受。相互依赖的操作必须留在同一 proposal，最多 5 个操作。不存在依赖半选的 UI。

proposal 保存 id、groupId、contextRefs、inputVersions、planningRevision、operations、reason、status、resultRefs。contextRefs 对应实际记录或 evidence ID，不能是模型虚构 ID。

apply：BEGIN IMMEDIATE → 检查 pending、输入实体版本和 planningRevision → 校验所有操作引用、固定事件冲突、任务字段 → 写全部操作 → 建立/取消提醒 → 标记 applied 与结果 → COMMIT。中间失败全部回滚，模型调用不在此事务中。返回 409 的提案保持可查看，可重新生成；同一提案再次 apply 返回既有结果。

planningRevision 为实例单行计数，课程、可用时间或任务计划时间变化时递增；用于保守失效排程草案。无需排程的单纯状态操作只检查其实体读集，不因无关资料变化失效。生成提案的工作流必须明确它属于哪种读集。

V1 主动工作流：

| 触发 | 自动行为 | 限制 |
| --- | --- | --- |
| 新通知 | 提取与筛选；已开启的来源规则可创建任务 | 未知条件不自动建任务；默认只出草案 |
| 保存日志 | 保存并显示“分析这个卡点”入口 | 不立即发 AI 邮件 |
| 主人点分析 | 读取关联任务与最近 7 天同项目日志，提出最多 1 份建议 | 无证据时追问或显示资料不足 |
| 启用周复盘 | 汇总最近自然周记录，最多 3 份独立建议 | 无新增记录不凭空编写成长结论 |
| 启用定期探索 | 执行指定方向检索，最多 3 个新候选并入周报 | 同证据候选不重复提醒 |
| 截止提醒 | 执行确定性时间规则 | 独立于 AI 是否可用 |

proposal.snoozeUntil、reasonCode、evidenceFingerprint 控制冷却；默认拒绝同项目同操作类型同证据的建议后 14 天不自动重复，用户可主动重跑。新正式截止或新的记录证据可产生新建议，但仍受每次上限约束。

## 7. 方向探索：输入、启动条件与结束判断

### 7.1 实践模板与候选

模板字段：id、version、direction、question、activities、prerequisites、requiredResources、estimatedMinutesRange、deliverables、firstStep、initialTasks、reviewQuestions、sourceLinks。首版维护 3 个可编辑模板，不做职业知识图谱。

初始主题为“小型分类基线及错误分析”“少量文本的检索比较”“一次简单程序或模型推理的计时对比”。它们是候选教学实践，实施者必须为每个模板补充可访问的具体数据/教程来源并核实许可要求，再将模板状态从 draft 改为 ready；不得把本段主题名当成已完整的课程内容。

每份 Candidate 增加：sourceRefs、evidenceStatus(snippet|retrieved|user_supplied)、requirements[{label,status:met|unmet|unknown,basis}]、estimatedMinutesRange、deliverable、firstTask、fitReason、unknowns。

“可以开始”仅在关键资源与所需基础经主人确认具备时显示。否则可保存为 idea，或选择“带这些未知条件开始”并记录主人选择；不能悄悄把未知变为满足。每个 firstTask 需给输入与可检查产出，初始任务最多 5 个，主人可编辑。

### 7.2 搜索预算与引用

默认每次最多 3 个 query、合计 6 个提取页面、3 个展示候选、180 秒总预算；AI 并发 1。所有重试计入同一预算，明确可重试失败最多重试 1 次；结构化输出修复最多 1 次，失败停止并保留可读错误。

SearchHit 与 EvidenceDocument 保存独立 ID；模型只能引用提供的 ID。候选事实需引用证据文本中的具体片段，保存原文片段位置或 quote；程序验证片段存在，人工样例验证语义是否被曲解。出处存在不等于事实已被完整核实，UI 分别表达取回原文状态和条件确认状态。

canonical URL 只去 fragment、明确的追踪参数和默认端口，保留语义 query；规范化不能把不同课程或项目页面合并。evidence_hash 使用本次用于推荐的事实摘录，页面导航变化不算新机会。重复候选按 topic+canonical URL 比较，条件、截止或核心内容变化才再次提醒。

定期默认每周一次，用户明确开启并选择本地时间；nextRun 使用时区库计算，topic 版本变更使未开始旧 job 失效，已在途结果入库前再检查 enabled 与版本。取消后可保存运行诊断，不发布候选或发摘要。错过多个周期只生成一个当前 run。

### 7.3 探索结束

项目开始保存“想验证的问题”和开始倾向(unknown|interested|unsure)。完成或暂停时可填：实际体验的活动、continue/change/undecided、理由、成果引用。

填写后只记录本次主人结论；更新关注方向需要另一个明确操作。选择“暂时没时间”只能延后建议，不降低兴趣；没有结束反馈时显示“项目已完成，探索结论未填写”。报告引用用户自己的结论，不生成职业适配分数。

## 8. Job、邮件与改期竞争的确定边界

### 8.1 Job fencing

jobs 必须有 lease_token、lease_until、attempt、generation、run_at、payload、dedupe_key。默认 lease 60 秒、每 15 秒续租；外部请求最长 45 秒，总工作流不超过 180 秒。时间超过 lease 或续租失败时中断请求，并禁止提交结果。

领取、续租、业务结果提交和终结都使用 token+generation 条件更新；结果事务内先检查 token 仍持有且 lease 未过期。旧执行者恢复后即使拿到了模型结果也不能落业务数据。长期停顿不是继续拥有任务的依据。

纯计算 job 租约过期可重新排队；带 SMTP 副作用的 delivery 一旦 submitting，恢复为 unknown，不能按普通 job 重试。一个 worker 的设计也要遵守这些规则，以处理异常重启重叠。

SQLite 写事务保持短；使用 BEGIN IMMEDIATE、busy timeout 和少量有界重试。文件必须位于同机本地磁盘；不把模型等待放入事务。[SQLite 事务文档](https://sqlite.org/lang_transaction.html)、[WAL](https://sqlite.org/wal.html)

### 8.2 邮件发送准入

reminderRevision 与 Task.version 分开。截止、提醒规则、状态变为 done/cancelled、归档，以及从终态重新打开为 todo/doing/blocked 都递增 reminderRevision；普通标题或备注变化不重建已发提醒。未准入邮件使用发送时最新标题生成正文。

重新打开时在同一事务取消旧未准入提醒，并且只建立触发时间在当前时刻之后的新版本提醒；过去触发点进入今日待处理，due=none 不建提醒。重复打开同一状态是幂等无变更，不递增 revision 或再建提醒。V1 不提供恢复归档的入口，若以后增加，同样适用恢复活动状态规则。

准入短事务：验证有效 job lease、任务未结束、reminderRevision 相符、提醒未过期 → delivery queued→submitting，分配 requestId、冻结收件人和正文快照 → COMMIT → 调 SMTP。

改期事务在准入之前提交：旧邮件不能再准入。改期发生在准入之后：在途旧邮件允许到达，UI 提示“存在发送中的旧提醒”；无法承诺撤回。邮件链接指向当前任务，正文标明内容生成时间。

状态为 queued/submitting/accepted/failed/unknown/cancelled。accepted 是发送服务接受，不是入箱或已读。提交后落库前崩溃为 unknown；默认不自动重发，主人检查后显式重发产生新 attempt，并提示可能重复。

模板 V1 只提供标题前缀、栏目开关/顺序、摘要长度、主题色、隐私模式和时间。模板代码随应用发布，不允许界面提交任意 HTML/脚本。高级任意模板编辑明确放后续。正文和变量转义，纯文本版同时生成；预览不发送。

## 9. API 补全与错误契约

所有业务路由前缀 /api/v1；浏览器安全 Cookie + CSRF，导入 bearer token 限 source。调用失败返回 {error:{code,message,details?}}；details 不含密钥或完整原始群聊。

| 路由 | 方法与关键行为 |
| --- | --- |
| /setup | POST，SETUP_TOKEN + 主人密码，一次性关闭；唯一 owner 事务保护 |
| /auth/login, /auth/logout, /auth/sessions | POST/POST/GET；会话撤销 DELETE /auth/sessions/:id |
| /profile, /settings | GET/PATCH，非秘密设置，带 expectedVersion |
| /goals, /projects, /tasks | GET/POST；/:id GET/PATCH；归档 POST /:id/archive |
| /fixed-events, /availability | GET/POST，/:id PATCH/DELETE；固定事件例外 POST /fixed-events/:id/exceptions |
| /planning/week, /today | GET，返回已知负担、未知估时数量、冲突与更新时间 |
| /inbox/import | POST NoticeImport，重复返回原结果；来源碰撞 409 |
| /inbox/:id, /inbox/:id/resolve | GET/POST，resolve 必填作用域 this_revision/profile/rule |
| /profile-rules | GET/POST；/:id PATCH/DELETE；变更后只标待重评 |
| /logs, /artifacts, /resources | GET/POST；/:id GET/PATCH/DELETE；resources 仅文本/URL，软删除 |
| /explorations | POST {query,topicId?,projectId?}，Idempotency-Key 在请求头，202 {jobId,runId} |
| /explorations/:id, /candidates/:id | GET，候选和来源状态；POST /candidates/:id/create-project，主人编辑确认后创建 |
| /exploration-topics | GET/POST；/:id PATCH/DELETE，停用增加版本 |
| /assistant/requests | POST {scopeType,scopeId,question}，限定 project 或 week，返回 202 jobId |
| /proposals/:id/apply, /proposals/:id/reject | POST，原子全量操作；反复 apply 返回既有结果；过时 409 |
| /reviews | GET；POST /reviews/generate 返回 202；/:id GET/PATCH |
| /jobs/:id, /notifications, /deliveries | GET，说明阶段和错误；不以 HTTP 202 表示完成 |
| /mail/preview, /mail/test | POST，preview 不产生发送；test 只向 MAIL_TO，主人主动点击 |
| /exports | POST {type:project_markdown|full_json,selectedIds,fields}，202 |
| /exports/:id/download, /exports/:id | GET 鉴权下载 / DELETE 删除导出；到期 410 |

通用语义：创建 POST 要求 Idempotency-Key（登录等会话操作除外）；成功创建 201，幂等重放返回相同资源，key 相同内容不同 409。PATCH、归档与删除要求 expectedVersion，版本不匹配 409；输入错误 422，未登录 401，权限不足 403，缺配置 503 INTEGRATION_UNAVAILABLE，超预算 429 BUDGET_EXCEEDED。

资源软删除保留已有引用可读但标记已归档；硬删除不是 V1 API。日期和关联 ID 由服务端校验。导出文件在实例私有目录保存 24 小时后过期，下载 GET 不触发重新生成。

补充表 resources(id,kind:text|url,title,body,url?,source_year?,source_kind,version,archived_at) 与 exports(id,type,selected_fields,status,private_path,expires_at,error)；正文引用资源时保留 revision/hash，后续编辑不改变旧提案依据。

## 10. 部署、恢复与兼容任务

### 10.1 交付路线

V1 必须交付 Dockerfile、compose.yaml、配置示例、从源码构建说明和运维脚本。公开镜像发布属于后续授权动作，不作为代码完成前提。web 在容器内监听 0.0.0.0:3000，Compose 映射为宿主 127.0.0.1:3000:3000；主机反代转发至该宿主环回端口。若反代也在容器中，使用共享网络的 web:3000，不能把反代容器自己的127.0.0.1当作web。文档给一份 HTTPS 示例，不默认暴露应用端口到公网。

迁移只有独立 migrate 命令执行：停止 web/worker → 备份 → migrate → 启动 web/worker；服务进程只检查 schemaVersion，发现不兼容即退出并说明，不在两个进程启动时竞争改表。

运维脚本契约：scripts/build.sh、start.sh、stop.sh、migrate.sh、backup.sh、restore.sh、resume-after-restore.sh。路径来自经验证的显式参数；涉及删除时按用户要求使用经核对的字面路径，不用变量拼接 rm。脚本须有失败即停止和可读错误，不能打印密钥。

没有 VPS 写权限时，只构建本地部署包、写明命令和未验证项，不执行远程发布。模型、SMTP 和搜索真实联调可以独立于 VPS 上线完成。

### 10.2 备份与恢复

V1 使用停机备份 CLI：停止 web/worker并确认退出 → 使用数据库备份机制或在完全停机后复制数据库完整文件组 → 记录 schemaVersion、应用版本、时间、文件 hash → 创建私有备份包 → 按原状态启动。V1 无附件，导出缓存无需备份。不要在写入中的 WAL 数据库上只复制主文件。

**恢复必须默认暂停所有外部动作。** restore.sh 在恢复结束、任何进程启动前写入实例的持久 restored_hold 状态（数据库或独立运行控制文件，但必须由 restore 命令重设），增加 deploymentEpoch。旧 job 的 lease 一律失效；submitting/unknown 统一为 unknown，其他待执行旧 job 标记 restored_pending。

恢复后只启动可登录检查的 Web；worker 的邮件、搜索、模型调用入口都检查 hold。主人核对任务与恢复时间，确认旧实例 worker 已停止；过去提醒只显示待处理摘要，不自动补发。resume-after-restore 需要显式确认，取消恢复出来的历史 job，根据当前任务重建 **触发时间晚于恢复启用时点** 的未来提醒；周期任务从下一个周期启动，不补跑恢复缺口。

若主人需要一份遗漏事项邮件，由其另外点击发送摘要；不得从旧备份推断备份后邮件是否已经送达。恢复回退也走此流程。新实例无法保证远端旧实例已停止，操作说明和确认必须明确这一外部前提。

full_json 是个人业务数据导出，不含密码摘要、session、integration token、secret、私有路径与后台投递队列；保留业务关系 ID。项目 Markdown 只导出主人选中的成果和记录，不把 full_json 称为可公开报告。

### 10.3 旧工具兼容

只检查旧项目的任务表、状态/日期字段、项目关系及通知输入，不扩展到无关审计。旧数据导入先 dry-run，使用 sourceInstanceId + oldId 的映射表，重复运行返回已有资源；时间和状态不能理解时报告并跳过，不能猜测。

插件桥接必须提供稳定 source 与 externalId；旧插件做不到修订顺序时使用 revisionOrder:null 待确认流程。未获得旧格式或未跑真实导入，兼容功能标记 unverified，既有服务继续使用。

## 11. 固定验收夹具与最少行为集

fixtures 全部为人工构造的演示数据，文件元信息标记 synthetic，不包含真实个人隐私。每个功能允许最少的正反例，围绕这些真实风险测试，不创建大而空的测试覆盖率目标。

| 编号 | 输入或故障序列 | 必须得到的结果 |
| --- | --- | --- |
| F1 身份符合 | 主人本科一年级；通知面向所有本科一年级，需提交表单 | applicability TRUE，action 草案，有原文引用 |
| F2 身份不符 | 同主人；通知仅限研究生 | FALSE，folded，可找回 |
| F3 条件未知 | 通知要求主人未提供的资格 | UNKNOWN，review；不据标题猜资格 |
| F4 纠正作用域 | 本次自愿活动设不参加，然后导入下一次同类活动 | 新通知仍为 opportunity，身份不变 |
| F5 修订与去重 | r1→r2→r1；主人在 r2 前改过任务标题 | 一个逻辑通知；current=r2；标题与状态不覆盖；任务不复制 |
| F6 周负担 | 净可用 600 分钟，缓冲20%，任务540分钟+1项未知 | 至少超量60分钟，并显示1项未知；没有时间数据时不报合理 |
| F7 实践可行性 | 候选需 GPU 或受限数据，主人条件未知 | 标未知或未满足，只能存 idea/确认带未知启动；不能标已核实 |
| F8 实践闭环 | 问题→最多3候选→选择→具体项目任务→成果→本人结论 | 可追溯开始疑问与结束判断，未反馈就不生成适配结论 |
| F9 提案原子性 | 多操作其中一个实体版本已变；再重复提交合法提案 | 前者全不写入，409；后者只应用一次，返回相同结果 |
| F10 排程读集 | 提案生成后修改可用时间，任务版本未变 | planningRevision 变化使排程提案 409 |
| F11 租约隔离 | A过期、B领取、A恢复返回模型结果 | A不能落业务结果；B可按当前token提交 |
| F12 邮件准入竞态 | 分别在 queued→submitting 前/后改期 | 前者旧邮件不发；后者允许一封在途邮件并提示，不谎称撤回 |
| F13 SMTP不确定 | 外部接受后进程退出，结果未落库 | unknown，恢复不自动重发 |
| F14 恢复旧备份 | 备份后某封邮件已发，再恢复旧queued备份 | hold 状态无外部请求；确认后只重建未来提醒 |
| F15 搜索失败 | 超时、429、只有摘要、无效模型 JSON | 有界重试；标明证据状态；不编造完整资料或项目 |
| F16 停用探索 | job已领取时关闭topic，之后返回结果 | 不发布候选、不发摘要，诊断可保留 |
| F17 日志草稿 | 离线保存→重新登录→同ID提交两次 | 仅一条记录；不同内容同ID为409；进展与卡点至少一项非空 |
| F18 导出 | 未登录下载、过期下载、选定日志报告 | 分别401/410；报告只含所选内容，full_json不含凭证 |
| F19 日期与周期 | 仅日期截止、明确23:30时刻、学期结束、DST例子 | 日期结束后才逾期；绝对时刻不漂移；课程到期停止；DST按已定义规则 |
| F20 无AI与首次部署 | 完全未配置模型/搜索；新空实例启动 | 手动核心可用，缺能力提示；无开放注册；未登录不可读数据 |
| F21 周中容量 | 周一计算净可用600分钟；到周五已完成360分钟、未来净可用120分钟，仍有180分钟未完成 | 整周承诺仍含done；剩余容量96分钟、剩余负担180分钟，显示至少84分钟缺口，不用过去空闲补足 |
| F22 重新打开 | 未来截止任务done→todo，连续重发同一请求，再将due设none | 第一次新revision恰好一组未来提醒；重复请求不重复；due清空后不留未准入提醒 |

浏览器只走三条完整路径：通知→任务→改期；探索→项目→成果；日志→复盘→应用建议。额外在桌面与 Android 常用宽度验证今日、输入、提案和配置，不把一张截图算完整验收。

外部联调单独列：真实模型响应及结构输出；真实搜索与原文来源；真实 SMTP 收件（HTML+纯文本）；真实旧插件或旧数据迁移；实际 VPS 部署。没有相应条件时明确未验证，不用 fixture 代替勾选。

## 12. 停止条件、阶段报告与最后交接

日用切片：T0–T4 完成，可安排任务、分流通知和提醒；它不是完整职业探索 V1。

完整 Web V1：T0–T7，真实模型/搜索/SMTP 联调通过，三个浏览器闭环和备份恢复通过，支持可配置邮件与定期探索。T8 完成前只能称为新平台 V1，不能宣称既有 Todo/插件已迁移完成。需要面向原用户正式切换时，T8 亦为必需。

本地工程完成但缺凭证时可交付可运行代码与缺项清单，状态写“本地工程完成，真实集成待验证”，不得写全功能验收完成。

每个开发任务最后报告：

1. 本任务实际实现的可见行为。
2. 关键规则/API/数据迁移变化。
3. 实际执行的验证及结果；区分 fixture、浏览器、真实端点。
4. 未完成与受外部条件限制的部分。
5. 下一项任务与所需输入。

本规范未授权代理自动报名、给老师发信、公开成果或更改旧生产系统；邮件功能授权是产品需求，开发时发送真实测试邮件须在该实施会话中由主人指定收件与测试行为。


## 13. A 方案 UI 实施契约

本节与完整产品计划 v1.2 第 5 节配套。用户已经选择 A「顶部状态带＋下方双栏」，不再开展 A/B 选择，不实现布局切换。业务规则以前文为准，界面呈现按本节和产品计划第 5 节执行；发现真实冲突先记录并修正，不能沿用旧原型的简化数据。

### 13.1 页面和组件边界

路由：`/today`、`/plan`、`/explore`、`/inbox`、`/inbox/[id]`、`/reviews`、`/reviews/[id]`、`/projects/[id]`、`/settings`、`/notifications`、`/setup`、`/login`。登录后 `/` 跳到 `/today`。主导航仅今天／计划／探索／收件箱／回顾；项目归属计划，设置位于次级入口。

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| AppShell | 响应式导航、当前位置、近期项目入口、主内容区域 | 业务过滤与容量计算 |
| WeekStatusStrip | 本周重点、已知负担、未知数、未来容量及依据 | 在客户端另算一套排程结论 |
| TaskList / TaskRow | 明确分组、状态提交反馈、关联入口 | 将通知未知项自动建成任务 |
| DecisionList | 条件未知和有效提案的摘要、数量及详情入口 | 用模型分数决定资格 |
| QuickLogForm | 明确关联对象、独立草稿 ID、进展和卡点 | 用全局单份文本替代多条持久日志 |
| EvidenceDetails | 来源修订、引用、获取时间、证据状态 | 运行外部页面中的指令 |
| ProposalDiff | 每份提案完整差异、证据、版本冲突反馈 | 拆开任意半选或直接调用数据库 |
| CandidateCard | 问题、活动、条件、产出、材料、投入 | 自动宣称用户适合某方向 |
| IntegrationStatus / DeliveryStatus | 缺配置、排队、失败、未知等真实状态 | 将 accepted 显示为已送达 |

样式 CSS Modules + 统一设计变量；V1 随系统亮暗，不新增手动主题选择。产品计划的尺寸和颜色为初始值，实际排布和对比度以浏览器验证为准。

### 13.2 首页读取契约与缺失字段补全

`GET /today` 返回一个有共同 `asOf` 的摘要快照。数据按实例时区确定 today 与 localMonday；客户端不跨多个独立请求拼出互相矛盾的负担数值。普通刷新不触发模型调用。

```ts
type TodaySummary = {
  asOf: string; timezone: string; localDate: string;
  week: { localMonday: string; endsAt: string };
  focus: null | {
    title: string; goalId: string|null; projectId: string|null;
    confirmedAt: string; version: number;
  };
  workload: {
    remainingKnownMinutes: number;
    remainingUnknownCount: number;
    futureCapacityMinutes: number|null;
    bufferPercent: number;
    estimateMode: 'full_estimate_for_unfinished';
  };
  actions: Array<{ task: Task; section: 'overdue'|'today'|'upcoming'|'this_week' }>;
  moreActionCount: number;
  decisions: Array<
    { kind:'inbox'; id:string; title:string; version:number; href:string }
    | { kind:'proposal'; id:string; title:string; version:number; href:string }
  >;
  moreDecisionCount: number;
  recentLogs: Array<{ id:string; occurredOn:string; progress:string;
    blocker:string; taskId:string|null; projectId:string|null }>;
};
```

`actions` 默认最多六项，`decisions` 最多三项，`recentLogs` 最多三条；完整内容通过页面列表查询。无可用时间配置时 capacity=null；显式设置零可用时间时为 0，不能混淆。部分任务未知时仍返回已知估时与未知数量。数据库读取失败返回错误，不把所有字段改为零。

新增 `weekly_focus` 表：id、local_monday、timezone、title、goal_id nullable、project_id nullable、confirmed_at、version；`(local_monday,timezone)` 唯一。每周最多一项重点，goal/project 至多关联其中一个，可仅保存文本。`GET /planning/week` 同时返回当周重点；`PUT /planning/week/focus` 创建携带 Idempotency-Key，更新携带 expectedVersion；`DELETE /planning/week/focus` 带 expectedVersion。首次设置由主人确认，AI 不自动写入。此项是为了实现已选择首页的必要契约，不改变目标模型。

补全前文简写的列表／动作路由：`GET /inbox`、`GET /proposals` 支持按状态查询；`POST /proposals/:id/snooze` 携带 expectedVersion 和 snoozeUntil，明确隐藏至何时，默认实例当地次日09:00，期满展示前重新检查有效性。提案的 pending 状态和 snoozeUntil 分开保存，暂缓不等于拒绝。

长任务取消增加 `POST /jobs/:id/cancel`：queued 可取消；running 保存取消请求，在外部调用前与业务发布前检查。取消不承诺撤回已发送网络请求或已准入 SMTP；邮件的不确定结果继续按第 8 节处理。取消接口只允许主人可见且可取消的作业类型，不能成为任意后台任务管理器。

### 13.3 前端交互规则

- 首页完成任务：行内 pending，失败保留原状态；成功后刷新相关 today/week 查询。不能先展示完成后忘记处理服务端失败。
- 记录：每次新记录生成独立 clientEntryId，关联对象显式显示；至少进展或卡点一项非空。保存成功后清理该草稿，失败或 401 不清空。关联对象冲突保留文本让主人重新选择。
- 提案：页面展示完整差异与来源。apply 成功以 resultRefs 回看结果；409 不自动重发覆盖最新数据，显示过时原因并允许重新生成。
- 通知：applicability、分区和处理状态分别展示；仅本条不参加不改成“资格不符”。修改身份和跨通知规则需要明确提交作用域。
- 候选转项目：先编辑草案与条件，再 POST 创建；保存 idea 和开始 active 是明确不同动作，未知条件开始必须记录本人确认。
- 离线：仅新增日志草稿；页面显示最近一次数据更新时间，不允许离线改变计划、接受提案或写规则。不能依赖 Service Worker 已缓存整站。
- AI：输入问题和用户尚未提交的编辑保持不变；后台失败在所属区域提示；缺配置有去设置说明入口。基础任务操作持续可用。
- 邮件：preview 不调用发送；test 独立按钮并显示 MAIL_TO 的非敏感可读地址；unknown 的重发需要提示可能重复。邮件中的业务链接只读打开页面。

### 13.4 阶段落点

| 阶段 | UI 交付 |
| --- | --- |
| T0–T1 | 设计变量、AppShell、初始化／登录、系统主题、独立 fixture 模式标识 |
| T2 | A 首页、weekly_focus、计划／项目、记录／成果、ProposalDiff 和版本冲突；三个宽度的基本操作 |
| T3 | 邮件模板预览、配置状态、投递记录、失败与 unknown 文案 |
| T4 | 收件箱列表／详情、三种纠正作用域、修订差异 |
| T5 | 探索输入与运行状态、候选比较、项目草案编辑、订阅开关 |
| T6 | 回顾页面、证据与本人修订、独立提案处理和报告预览 |
| T7 | 草稿／会话过期、导出状态；补齐全部关键断点、两种系统主题与键盘流程 |

### 13.5 界面验收补充

本表作为 F1–F22 的 UI 观察点，尽量复用既有夹具和三条主流程，不增加同义测试集。

| 编号 | 场景 | 观察结果 |
| --- | --- | --- |
| U1 | A 首页正常／无数据 | 顶部状态带与下方双栏；无资料不编目标、容量或成长分 |
| U2 | F6/F21 未知估时／周中容量 | 口径准确；未知单列；0 与 null 不混淆；超量用文字解释 |
| U3 | 任务提交失败／401／409 | 不显示虚假成功，输入和现有状态保留，可恢复 |
| U4 | F3/F4 条件未知与纠正 | 来源可见，不生成自动正式任务；单条纠正不改变身份 |
| U5 | F7/F8 探索实践 | 候选可比较，未知条件明确，创建的是独立项目，有本人结束判断 |
| U6 | F9/F10 提案过时 | 显示前后差异与失效原因；不提供原子提案内部半选 |
| U7 | F17 草稿与重新登录 | 本机／提交中／已保存／失败可分辨；重新登录不丢输入 |
| U8 | F12/F13 邮件状态 | accepted 与 unknown 文案准确；预览不发送；旧在途提醒提示可见 |
| U9 | 320/390/768/1024px 与宽桌面 | 关键文字、长标题与按钮不横向溢出；手机状态和行动均可找到 |
| U10 | 两种系统主题、键盘与减少动效 | 状态不只靠颜色；焦点可见；可完成记录和确认；无强制循环动画 |

原型曾做的局部验证不替代本表。实现完成报告需注明实际浏览器、页面、宽度和交互路径，不能把未覆盖的亮色或小屏状态写成全部通过。
