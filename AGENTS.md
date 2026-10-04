# Dash Campus 智能体接手说明

本仓库是单用户、自部署、Web 优先的学习与职业探索工作台。代码在 `app/`。当前工作是在已有 Agent-first V2 上修复易用性并扩展自研 Agent，不能从头重建框架或从旧 P0 重新铺空壳。

## 开工必读

按以下顺序阅读：

1. `app/docs/STATUS.md`：当前交付范围、待实施状态、证据边界。
2. `app/docs/agent-first-v2/START-HERE.md`：完整接手顺序、第一工作包和验收规则。
3. `app/docs/agent-first-v2/REPAIR-BASELINE-2026-10-04.md`：已复现的九项缺口与隔离复现方法。
4. `app/docs/agent-first-v2/REPAIR-PLAN-2026-10-04.md`：R0–R5、课表可视化、共享预算、每日智能安排、自然语言修改。
5. `app/docs/agent-first-v2/AGENT-INTERFACE-CONTRACT.md`：全业务工具、通用问答、命令注册表与HTTP接口对齐。
6. `app/docs/agent-first-v2/ACADEMIC-CALENDAR-AND-HOLIDAYS.md`：校历、官方假日/调休、学校补课映射。
7. `app/docs/agent-first-v2/MASTER-PLAN.md`、`CODING-AGENT.md`、`app/AGENTS.md`、`app/docs/deploy.md` 和相关实际源码。

优先级：当前用户指令 > 适用 AGENTS > 新修复/接口/校历规格 > MASTER-PLAN > 旧 `Plan/` 和历史实施记录。遇到目标规格与代码不一致，记录缺口并修代码，不把规格当已实现。

## 工作约束

- 命令使用 Git Bash，先写脚本再执行；删除/移动不使用可能为空的变量，先核对明确目标归属。
- 旧 Todo 数据、附件、配置、服务与同步任务只读，禁止写入、删除、停止或改造；派生状态只存 Dash。
- 使用独立开发/测试数据库。用户允许重建 Dash 不等于允许直接清生产；迁移向前编号，不能改已部署迁移。
- `.env`、凭证、私钥、数据库、私人原件、生产连接信息、临时 `.planning/` 不入提交。
- 模型只调用有类型的注册业务操作；chat、按钮和兼容API复用领域服务。时间与冲突计算由确定性算法执行，实际/计划/假设分开。
- 保持自研有限步骤 Agent，不引入外部 coding agent 运行时。不要换技术栈或只加聊天框。
- 修改 `app/` 代码前读 `app/AGENTS.md` 以及相关 Next 本地文档。针对真实改动运行必要测试，不做无关门禁。
- 保护既有未提交改动。未要求不 commit/push/部署；本轮规划推送授权不自动授权后续代码上线。
- 推送文档不代表修复或部署完成。报告分清目标规格、实现、隔离行为、真实provider/网页、生产核对和主人试用。

## 默认开工动作

核对 HEAD、工作区与迁移最大号，读上述文件后从 R0/R1 的“课程事实/校历解释 → 共享预算 → 稳定排程”开始。主动提问、自然语言修改及其他业务按依赖继续，验收 E01–E49。不停在重新写计划、空接口、测试数或旧 A01–A22 的全绿标签。
