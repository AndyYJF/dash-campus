# Dash Campus

单用户自部署的校园计划与记录应用。代码在 `app/`，产品计划在 `Plan/`，脚手架脚本在 `scripts/`。

**日常使用先看 [用户手册](app/docs/USER-MANUAL.md)**：从首次登录、导入课表到自然语言调整、计时记录、复盘和排错，按当前界面的实际操作讲解。

**智能体接手先读根 [AGENTS.md](AGENTS.md) 和 [START-HERE](app/docs/agent-first-v2/START-HERE.md)。交付与最近部署记录统一见 [STATUS](app/docs/STATUS.md)，产品取舍见 [决策记录](app/docs/decisions.md)。** `app/AGENTS.md` 只补充应用规则，`app/CLAUDE.md` 是导入入口；普通 `CODING-AGENT.md` 不另构成一套目录规则。

模型优先路由、执行核验、有限修正与多轮续办的 P0–P6 已实施；历史方案见 [Agent 增强 v1.1](Plan/dash-campus-AGENT-ROUTER-PLAN-2026-10.md)，验证边界见 STATUS。当前方向页的阶段地图、工作样本与五个操作（D0/D1）已交付，F01–F03 已复验关闭；D2–D5 仍需完成。见 [方向计划](Plan/dash-campus-DIRECTION-POLISH-PLAN-2026-10-05.md) 与 [方向验收报告](Plan/dash-campus-DIRECTION-ACCEPTANCE-2026-10-05.md)。

工作台已有课表可视化、共享预算与每日安排，校历、官方节假日和学校补课共同影响行动。继续开发应按当前状态补足真实服务与用户试用验证，不从旧P0重建，也不要把下面的历史审计缺口全部当成待实现。旧Todo只读保护是硬边界。

- [易用性审计基线](app/docs/agent-first-v2/REPAIR-BASELINE-2026-10-04.md)：九项已确认缺口和复现方法。
- [总修复计划](app/docs/agent-first-v2/REPAIR-PLAN-2026-10-04.md)：实施顺序、主要用户流程与验收。
- [Agent操作与接口契约](app/docs/agent-first-v2/AGENT-INTERFACE-CONTRACT.md)：领域工具、通用问答和HTTP对齐。
- [校历/节假日/调休规格](app/docs/agent-first-v2/ACADEMIC-CALENDAR-AND-HOLIDAYS.md)：导入、官方更新、教学映射与预算。
- [V2基础规格](app/docs/agent-first-v2/MASTER-PLAN.md) / [Coding Agent指令](app/docs/agent-first-v2/CODING-AGENT.md)：基础契约和历史上下文。合计E01–E49需按行为分层验证，不能用旧全绿映射代替。

本地启动见 `app/docs/deploy.md`。复制 `app/.env.example` 为 `app/.env` 后填写密钥；`.env`、数据库和生产主机信息不入库。

这版 Web 工作台支持目标 / 项目 / 任务管理、周计划与可用时间、身份筛选通知、原文提取、实践模板、记录与复盘，以及截止提醒和主动邮件摘要。模型、搜索和 SMTP 都可选，基础计划与记录独立可用。一个实例只服务一名主人。

历史审计基线（2026-10-04）为业务提交 `cbbaeee`、schema **23**；当时197个现有测试通过仍有实际行为失败。该基线用于理解修复背景，不代表当前完成情况。完整状态与验证边界见 [STATUS](app/docs/STATUS.md)。此前schema16发布、SDCT1导入和Web V1记录也属于历史证据，见 [历史状态](app/docs/web-v1-status-2026-10-03.md)。

此前Web V1迁移记录为旧 ToDo 的243条任务及1个项目、校园插件220条通知，并配置独立定时器每10分钟轮询；这些数量不代表当前实时状态。旧工具继续保留供查阅附件，来源更新不覆盖主人任务。操作与映射规则见 [旧工具兼容说明](app/docs/legacy-compatibility-2026-10-03.md)。当时真实测试邮件的收件行为尚待主人确认，不能据此宣称全部验收完成。
