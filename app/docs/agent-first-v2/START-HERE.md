# 从这里接手：V2 易用性修复与自研 Agent

更新：2026-10-05。Agent 语义修复（R01–R08、S01–S20，迁移 0033；复审修复 0034；过期未反馈块修复，当前生产 `de8adff`、schema 34）见下节；Agent增强 v1.1 的 P0–P6 已在 `main` 实现并逐包部署生产（`521aeaa`、schema32）；早先 R0–R5 与易用性修复的业务版本为 `95c8cf1`（schema29）。后续文档提交与业务部署修订分开记录。先读 [当前状态](../STATUS.md)、[产品与工程决策](../decisions.md) 及 [模糊调整的实现与证据](../flexible-adjustments-2026-10-04.md)。修复前审计基线 `cbbaeeeaa328807ebc97389a7a824f7acdb6c356` 只作历史，拉取后仍核对代码与工作区。

## Agent 语义修复（2026-10-05）

[语义修复提示词](../../../Plan/dash-campus-AGENT-SEMANTIC-REPAIR-PROMPT-2026-10-05.md) 的 R01–R08 与 S01–S20 已实现，迁移 0033（schema 33）。证据见 [语义修复验收](./acceptance-semantic-repair-2026-10-05.md)，接口见 [契约](./AGENT-INTERFACE-CONTRACT.md) 末节，取舍见 [决策记录](../decisions.md) 末节。新增代码入口：约束类型 `src/domain/constraints.ts`、目标约束 `src/repositories/goal-constraints.ts`、统一门 `src/workflows/agent-gate.ts`、确认事实与实际影响 `src/workflows/command-facts.ts`、步骤凭据 `src/repositories/step-executions.ts`；回归 `test/agent-semantic-repair.test.ts`（R01–R08）与 `test/agent-semantic-scenarios.test.ts`（S 场景）。原 G04“通过”因核对盲点作废。

复审修复（验收页 §8，迁移 **0034** `intakes.active_ms`，schema 34，生产 `1c7792f`）：解除约束单独授权、学习块按实际时间核对条件、对象身份统一由 `commandEntities` 解析、`in_background` 结果状态、180 秒按主动执行时间、指代不明请主人指认；回归 `test/agent-semantic-review.test.ts`。

过期未反馈学习块（验收页 §9，无迁移，生产 `de8adff`）：已结束没反馈的块挂住需求不整段补排（`awaitingFeedbackSessions`，`src/workflows/plan.ts`），每段一个“这段做了吗，还剩多少？”问题（`askSessionFeedback`，`src/workflows/agent.ts`），回答走现有操作；回归 `test/session-feedback.test.ts`。剩余需求的报告时刻用真实写入时刻（`src/workflows/ops/tasks.ts`），和学习记录同一时钟比较先后，不要改回规划时钟 `ctx.now`。

## Agent增强 v1.1（已实施，2026-10-05）

[Agent增强方案v1.1](../../../Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md)的模型优先路由、有界只读工具、多轮追问/改口/跨设备续办、执行后核验与有限修正、试用指标已实现。逐包实现与证据见[实施记录](./implementation-progress.md)，G01–G12 证据层见[验收映射](./acceptance-g01-g12.md)，接口见[契约](./AGENT-INTERFACE-CONTRACT.md)末三节。接手后优先补：登录态网页走查、主人七天试用（设置页“试用指标”）、真实邮件收件与复杂视觉材料。下列历史R0–R5说明用于理解既有系统，不要求重新实现。

代码入口：路由 `src/workflows/agent-route.ts`、只读工具 `agent-tools.ts`、决策 `agent-decide.ts`、投递管线 `intake.ts`、核验 `agent-verify.ts`、修正 `agent-run.ts`、指标 `agent-metrics.ts`、预算与 trace `ai-budget.ts`/`agent-trace.ts`、注册表 `src/contracts/commands.ts` 的 `OPERATIONS`。真实模型评测 `scripts/eval-agent.mts`（固定语料）与 `scripts/eval-goal-flows.mts`（多轮目标），凭证只经环境变量。

## 1. 要完成的用户体验

用户通过一个入口扔材料、表达意图、回答问题。自研 Agent 主动补关键事实，决定并执行具体安排，维护身份筛选、任务、目标项目、资料、实践、复盘和提醒。用户随时自然语言修改/撤销，主要看结果和行动，不维护一堆表单。

今天/本周共用课程、校历、生活保留、实际投入和剩余需求。桌面显示七天时间轴，手机显示日时间线；课程/空档/学习安排联动。自动获取官方节假日/学校调课；国家补班与学校补课映射分别处理。保留休息，近期安排稳定。

## 2. 文件地图与阅读顺序

| 文件 | 用途 |
|---|---|
| [当前状态](../STATUS.md) | 唯一当前交接入口；历史部署与本次规划分开 |
| [Agent增强v1.1](../../../Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md) | P0–P6、参数级授权、多轮与执行闭环，G01–G12验收；已实施，证据见[验收映射](./acceptance-g01-g12.md) |
| [审计基线](./REPAIR-BASELINE-2026-10-04.md) | 九项实际失败路径、源码定位与复现规则 |
| [总修复计划](./REPAIR-PLAN-2026-10-04.md) | 主工作包 R0–R5；E01–E29；开发启动指令 |
| [Agent接口契约](./AGENT-INTERFACE-CONTRACT.md) | 操作矩阵、通用问答、领域命令/HTTP对齐；E30–E39 |
| [校历与假日规格](./ACADEMIC-CALENDAR-AND-HOLIDAYS.md) | 校历图片/PDF/链接导入、年度假日、补课映射与预算；E40–E49 |
| [V2基础规格](./MASTER-PLAN.md) | 来源、事务、授权、时间预算、导出恢复等基础契约；初始基线已过期 |
| [Coding Agent指令](./CODING-AGENT.md) | 约束和历史建设上下文；新修复入口优先于旧P0–P6 |
| [E01–E49 验收映射](./acceptance-e01-e49.md) | 初始隔离验收与缺口；当前真实模型/生产证据看 STATUS 和各发布记录，主人试用未完成 |
| [决策记录](../decisions.md) / [模糊调整](../flexible-adjustments-2026-10-04.md) | 统一输入、查询只读、事实决策、默认/明确范围、问答与确认边界；实现入口和验证范围 |
| [实施历史](./implementation-progress.md) / [旧验收映射](./acceptance-map.md) | 各工作包的实现与当时验证；旧 A01–A22 不代表新修复完成或长期易用性通过 |
| [运行说明](../deploy.md) | 配置/web+worker/迁移/备份；不要盲用旧生产回退记录 |

先读根目录 `AGENTS.md`、本文件、STATUS与Agent增强v1.1，再读相关领域规格、实际代码及 `app/AGENTS.md`。工作在 dash-campus；不需要私人聊天历史、截图目录、服务器凭证才能开始本地实现。

## 3. 本轮开工与既有待验证项

本轮按Agent增强v1.1的P0–P6实施。以下是现有产品尚未完成的验证与兼容工作，继续保留，不代替本轮主线，也不因新增方案而自动完成。

1. 补复杂课表截图、扫描 PDF 的真实视觉验证，以及真实模型的模糊调整追问续答。官网校历图片和简单调整已验证，不能据此推断任意材料/问答都可靠。
2. 配置邮件后做 E23/E34 的真实投递与收件核对。
3. 语义修复带迁移 0033，复审修复带 0034（当前 schema 34，部署状态见 STATUS）；后续改动按实际迁移版本、匹配备份/回退和公开行为验证发布，不重复执行旧迁移或重建生产。部署仍须相应用户授权。
4. 主人连续七天试用，记录 REPAIR-PLAN §8 列的指标并修正。
5. 把仍在使用的 v1 写接口（候选/资料/身份规则/可用时间块/设置表单）逐个并入统一操作或同一份变更记录；课表导入和任务/目标/项目/固定活动表单已并入。

下面是修复开始时的第一工作包说明，保留作背景。

### 原第一工作包：R0/R1

1. 核对分支、dirty tree、package/迁移/导出模型；保留已有改动。隔离数据库路径必须在首次读配置前设置，不连接生产或 Todo 写库。
2. 按审计摘要建立有固定时钟的失败用例，优先“已学150/预算180仍超排”“重复重排换ID”“旧课程语义统计零”。新增用例应证明行为，不镜像实现。
3. 统一旧课程来源、校历事实和有效实例权威；来源不能证明的旧活动保留占用并标待核对，不猜原周次、不双扣。
4. 修共享预算账本、剩余任务语义、课程/生活约束和差异排程；保护24h内/锁定/开始块，用户明确修改按范围执行。
5. 有效课程和预算基础跑通后，继续R2的通用问答/命令/真实材料与结果，随后R3界面、R4策略及R5方向闭环。不要先交漂亮但错误的课表。

源码主要在 `app/src/domain/{budget,scheduler,calendar-occurrences,time}.ts`、`workflows/{plan,snapshot,intake,commands,undo}.ts`、相应 repositories/contracts，以及三页组件和 UniversalIntake。新增迁移号以实际最大值为准，不按旧文档写死23。

## 4. 验证与报告

- 按E01–E49记录 pending/implemented/isolated-pass/real-web-pass 等证据层，不能直接把目标规格全部勾绿。
- 真实截图课表/校历、通用回答、自然语言修改、撤销和页面刷新需要网页路径；模拟provider或文本PDF不能代替图片结构提取。
- 国家日期与教学周/补课映射不同；抓取403/未发布/未获取与全年无假日不同。
- 主人七天试用必须是真实使用，不能由模拟时钟或“最多3问”代替。
- 每包更新 implementation-progress 与 STATUS；原记录保留日期并标历史。普通决定自主处理，不反复问命名/库选择。
- 代码验证后再按当次授权提交/推送或部署；开发可在没有生产凭证时完成，不能从公开仓库寻找秘密。

（“原第一工作包”及初始建设说明保留历史背景，当前状态与下一步已更新。）

## 5. 可复制开工指令

> 接手dash-campus。先读根AGENTS、STATUS、START-HERE、Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md v1.1、decisions、接口契约与G01–G12验收映射，再读实际源码。Agent增强v1.1 P0–P6已实现（schema32）；接手后补登录态网页走查、主人七天试用、真实邮件收件与复杂视觉材料。核对最新代码/dirty tree/迁移，用独立库，沿用唯一OPERATIONS、参数级授权、请求级持久预算、步骤依赖与核验；G01–G12与相关E01–E49分别按证据层报告。Todo绝对只读，不清生产、不提交秘密，不引入外部codingagent、不换框架。命令Git Bash先写脚本，未获适用指令不commit/push/上线。
