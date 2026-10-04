# Coding Agent 开工指令

你要在现有Dash Campus工程继续修复Agent-first V2。先读 [START-HERE.md](./START-HERE.md)，基础契约见 [MASTER-PLAN.md](./MASTER-PLAN.md)。新修复/接口/校历规格优先于初始规格和旧Plan/T0–T8中的冲突规定。

**2026-10-04 修复入口：** 已有 V2 实施后的易用性修复，以及新增课表可视化与每日智能安排，按 [REPAIR-PLAN-2026-10-04.md](./REPAIR-PLAN-2026-10-04.md) 的 R0–R5 推进。下文 P0–P6 保留为初始建设历史；不要重新建空壳，不把旧验收全绿当作真实流程已完成。修复计划状态为待实施。

## 开工前必读

1. 本文件和MASTER-PLAN全篇；已有 V2 的修复还须阅读 REPAIR-PLAN-2026-10-04、[AGENT-INTERFACE-CONTRACT.md](./AGENT-INTERFACE-CONTRACT.md) 与 [ACADEMIC-CALENDAR-AND-HOLIDAYS.md](./ACADEMIC-CALENDAR-AND-HOLIDAYS.md) 全篇，定义自研 Agent 的全业务操作、接口与校历/假日规则。
2. 仓库适用AGENTS.md/用户指令、README、`app/docs/deploy.md`、`app/docs/legacy-compatibility-2026-10-03.md`。
3. `app/src/domain/workload.ts`、`calendar-occurrences.ts`、`schedule.ts`、`app/src/worker/runner.ts`、`app/src/workflows/http.ts`、`app/src/contracts/exports.ts`、`app/src/integrations/openai-chat.ts`。

工作在dash-campus，不在andy-blog。先读`app/docs/STATUS.md`，核对提交和工作区，保留运行时出现的既有未提交变更；未要求不commit/push。命令用Git Bash并先写脚本。生产状态另行核对，不能把Git分支或文档当作实时生产证明。

## 不可变边界

- 旧Todo数据库、附件、配置、服务、其同步任务不得修改/删除/停用；V2只有读取能力。
- 用户允许重建的是Dash自己的业务数据。先可恢复备份，再独立V2库；开发不直接清生产。
- 原件/事实/假设/计划/实际分钟分开；正式截止不自动顺延；模型不能执行任意SQL/shell。
- 新表纳入导出/恢复，附件也要实际恢复；hold期间无邮件/模型/搜索/拉源。
- 不把原功能菜单全部搬进新界面，不只加聊天框；新界面必须使用统一事实、时间预算和行动结果。

## 初始建设历史：P0 + P1的最小可运行切片

以下是历史开工顺序。当前第一工作包为 START-HERE 的R0/R1；只有核对源码后发现能力缺失，才按需补下列基础能力。

先完成以下切片，再扩大：

1. 定位真实仓库与dirty tree、schema及受保护来源；写`app/docs/agent-first-v2/implementation-progress.md`，记录事实、缺口和下一步。确认独立开发数据路径/epoch，不暴露生产secret。
2. 新增intake、extracted_documents、items、questions/answers的迁移、shared schema与repository，复用jobs与幂等事务。
3. 实现POST接收文字→持久化→异步解析、GET状态、POST回答；SDCT1用已有确定性parser，缺首周时在item层提问而不是直接422丢原文。
4. 全局统一输入与处理详情先在现有外壳接入；不要先改完所有导航。文字材料里同时含课表和一条实践记录，必须能够拆分并保存独立结果。
5. 一个首周问题回答后恢复课表分支，复用来源和版本机制；这一阶段只生成核对后的事实/候选效果，P2再加入正式自动执行及undo。
6. 验证未知锚点、独立item、不重复提交、重启恢复、过时答案、模型失败原文仍存。提供实际网页证据，不用静态源码断言替代。

P0/P1交付后立即继续P2/P3，目标是课表影响今天/周预算和安排任务。不要把“统一入口已接收文件”当成本轮结束。

## 后续依赖

| 阶段 | 依赖 | 交付核心 |
|---|---|---|
| P0 | 无 | 基线/保护/独立环境/provider/容量 |
| P1 | P0 | durable输入与多item问答恢复 |
| P2 | P1 | 自动执行policy、领域来源、版本journal、undo |
| P3 | P2 | 课程投影、学习块、实际用时、预算与三页前两页 |
| P4 | P1–P3 | 全文件provider/只读源，端到端接入同管线 |
| P5 | P3/P4 | 方向证据、主动维护、邮件策略 |
| P6 | 全部 | 新库切换、实际恢复、旧入口退休、最终验收 |

按MASTER-PLAN的A01–A22建立行为矩阵。针对当前改动跑必要测试；最终做共享基础回归与真实操作，不在每个小步骤重复全量测试。

## 遇到未规定细节

自行做最小一致选择并写decisions，不因普通命名/库选择/界面细节反复问用户。关键事实或行动对象不明确时，在产品内部用结构化问题询问；开发Agent不能代用户伪造答案。模型视觉缺能力按P0结论接本地OCR，无法部署时准确报告缺口，不绕成“图片仅上传”。

如果原代码默认值/旧接口与新语义冲突，优先保证V2唯一权威源，兼容接口通过适配进入同一命令。迁移到多session时不能新旧排程双写。来源同步只进入新source envelope，不能继续运行两条AI提取链造成重复。

## 每阶段报告只回答

- 用户现在可以完成哪条真实流程。
- 哪些字段是事实，哪些仍是暂定，问答和撤销是否有效。
- 验证了哪层，生产/真实provider/邮件到达哪些尚未验证。
- Todo保护是否仍成立，下阶段具体补哪条断点。

## 初始建设的历史启动Prompt

已有 V2 的易用性修复请使用 REPAIR-PLAN-2026-10-04 第 9 节的启动指令，下文仅保留初始建设上下文。

> 在dash-campus现有工程实施app/docs/agent-first-v2/MASTER-PLAN.md和CODING-AGENT.md。先核对基线、保留未提交改动、保护旧Todo只读，创建独立开发库。从P0/P1最小可运行切片开始，完成后按依赖推进P2–P6。目标是统一输入自动整理、关键缺口主动问答、课程/任务/实际投入共同驱动今天和本周、实践证据驱动方向。允许重建Dash业务数据但先备份和隔离切换，绝不修改或停止Todo。普通实现决策自主完成，不停在计划或空壳；按阶段真实验证并记录完成证据。规划文件不是生产功能证明；真实缺口明确标注。使用Git Bash，先写脚本再执行，不提交密钥、私人业务数据或生产连接信息，未要求不commit/push。
