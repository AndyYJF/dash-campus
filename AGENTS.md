# Dash Campus 仓库工作说明

适用于整个仓库。这里是单用户、自部署、Web 优先的学习与职业探索工作台，应用代码在 `app/`。在已有自研 Agent 上继续开发，不从旧 P0 重建框架。

## 指令文件的作用范围

| 文件 | 职责 |
|---|---|
| 根 `AGENTS.md`（本文件） | 仓库级规则与阅读顺序，适用于所有目录 |
| [app/AGENTS.md](app/AGENTS.md) | 继承本文件，只补充应用目录和 Next.js 规则 |
| [app/CLAUDE.md](app/CLAUDE.md) | Claude 的导入入口，引用根规则与应用补充，不另写一套规则 |
| `Plan/CODING-AGENT-开发执行计划.md`、[CODING-AGENT.md](app/docs/agent-first-v2/CODING-AGENT.md) | 普通开发交接文档，不是按目录自动生效的指令文件；旧建设顺序仅作历史 |

嵌套按目录划分作用范围，不代表要重复执行计划。不要在 `src/` 或文档子目录再复制仓库规则。Next.js 自动维护的标记块只保留在 `app/AGENTS.md`；不要删除整个应用指令文件来消除生成差异。

## 开工阅读

1. [STATUS](app/docs/STATUS.md)：当前交付、最近部署记录、剩余范围和验证边界，版本信息以此处为入口。
2. [START-HERE](app/docs/agent-first-v2/START-HERE.md)：接手地图、当前任务与可复制的开工指令。
3. [decisions](app/docs/decisions.md)：产品与工程取舍。
4. 按任务阅读对应计划、接口契约、验收报告与实际源码。方向页看 [方向计划](Plan/dash-campus-DIRECTION-POLISH-PLAN-2026-10-05.md) 和 [方向复验](Plan/dash-campus-DIRECTION-ACCEPTANCE-2026-10-05.md)；业务工具看 [接口契约](app/docs/agent-first-v2/AGENT-INTERFACE-CONTRACT.md)；日历看 [校历/假日规格](app/docs/agent-first-v2/ACADEMIC-CALENDAR-AND-HOLIDAYS.md)；运行看 [deploy](app/docs/deploy.md)。

早先 R0–R5、Agent 增强 v1.1 P0–P6 已实施；方向页 D0/D1 与 F01–F03 已交付，余项以 STATUS 为准。旧计划中“待实施”和当时版本不能覆盖最新交付记录。

当前用户指令与适用的目录规则优先；当前任务的目标规格、接口与决策优先于历史建设计划。发现目标与代码不一致时记录缺口，不把规格当作已实现，也不擅自丢弃目标。当前状态集中维护在 STATUS，其他入口引用它，避免到处复制“当前生产”版本。

## 工作约束

- 命令使用 Git Bash，先写脚本再执行；删除/移动前核对明确目标归属，删除命令不使用变量拼接路径。
- 旧 Todo 数据、附件、配置、服务与同步任务只读，禁止写入、删除、停止或改造；派生状态只存 Dash。
- 使用独立开发/测试数据库。用户允许重建 Dash 不等于允许直接清生产；迁移向前编号，不能改已部署迁移。
- `.env`、凭证、私钥、数据库、私人原件、生产连接信息、临时 `.planning/` 不入提交。
- 模型只调用有类型的注册业务操作；chat、按钮和兼容 API 复用领域服务。时间与冲突计算由确定性算法执行，实际/计划/假设分开。
- 保持自研有限步骤 Agent，不引入外部 coding agent 运行时。不要换技术栈或只加聊天框。
- 修改应用代码前读 `app/AGENTS.md` 与相关 Next 本地文档。针对真实改动运行必要验证，不做无关门禁。
- 保护既有未提交改动。未要求不 commit/push/部署；此前的规划推送授权不自动授权后续上线。
- 推送文档不代表修复或部署完成。报告分清目标规格、实现、隔离行为、真实 provider/网页、生产核对和主人试用。

## 默认开工动作

核对 HEAD、工作区与迁移最大号，按当前用户任务和 STATUS 的真实缺口工作。继续方向页时从 D2–D5 的剩余交付推进，保留首次版本 0、后续引用撤销冲突、关注后样本仍可读的回归；不能重新从已完成的 D0、R0 或 Agent P0 铺空壳。G/S/E 与方向场景按证据层报告，不停在计划、空接口、测试数或旧全绿标签。
