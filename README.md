# Dash Campus

单用户自部署的校园计划与记录应用。代码在 `app/`，产品计划在 `Plan/`，脚手架脚本在 `scripts/`。

**当前状态和下一步见 [STATUS](app/docs/STATUS.md)**。Web V1 修复和课表导入已经部署；Agent-first V2 已完成规划，P0–P6 尚未实施。此次完整交付位于 `codex/fix-v1-gaps` 分支，生产发布号与 Git 提交号分别记录。

新的开发方向为 **Agent-first V2**：统一输入、自动维护、主动澄清、课程与学习安排共同驱动今天和本周。可直接开工的规格见 [V2 总规划](app/docs/agent-first-v2/MASTER-PLAN.md)，开发交接见 [Coding Agent 开工指令](app/docs/agent-first-v2/CODING-AGENT.md)。这是目标规格，尚未实现；它替代旧规划中冲突的产品/UI规定。旧 Todo 只读保护是硬边界。

本地启动见 `app/docs/deploy.md`。复制 `app/.env.example` 为 `app/.env` 后填写密钥；`.env`、数据库和生产主机信息不入库。

这版 Web 工作台支持目标 / 项目 / 任务管理、周计划与可用时间、身份筛选通知、原文提取、实践模板、记录与复盘，以及截止提醒和主动邮件摘要。模型、搜索和 SMTP 都可选，基础计划与记录独立可用。一个实例只服务一名主人。

最近核验生产版本为 schema **16**，发布 `20261003-5b6c71b38362`，课表入口见 [SDCT1 导入说明](app/docs/timetable-import.md)。原 Web V1 T0–T8 的实现、真实集成、恢复验证及剩余收件验收见 [Web V1 最终交付记录](app/docs/web-v1-final-acceptance-2026-10-03.md)。首次使用见 [Web V1 修复与开发交付](app/docs/v1-completion-2026-10-02.md)。

旧 ToDo 的 243 条任务及 1 个项目已迁移；校园插件已接入 220 条通知，以独立定时器每 10 分钟轮询。旧工具继续保留供查阅附件，来源更新不覆盖主人任务。操作与映射规则见 [旧工具兼容说明](app/docs/legacy-compatibility-2026-10-03.md)。真实测试邮件的收件行为尚待主人确认，不能据此宣称全部验收完成。
