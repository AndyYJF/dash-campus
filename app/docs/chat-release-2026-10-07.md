# 聊天界面与对话修复发布记录（2026-10-07）

主人明确要求部署，发布名 **chat-20261007**。来源为基于 `main` / `origin/main` `feae568` 的本地工作区快照；使用独立 Git index 生成 tree **89aacda4a9414b926273c69101eba0b3c84d2bed**，没有提交、推送或修改正式 index。这个 tree 不是 GitHub 提交号，不能声称远端已同步。

## 发布内容及来源

完整 `/chat` 页、统一聊天浮层、按时间排列的消息、底部输入、分页滚动、问题回答后的续办结果；回答事务与旧卡片校验，以及 `/安排` 完整性/日期/钟点修复。具体行为见 [开发复验](agent-dialogue-robustness-2026-10-07.md)。

发布前生产478个相关源码文件与 `feae568` Git blob一致。旧 `.deploy-source-revision` 为 `3895aa3`，已经过时；不据此覆盖实际新代码。本次 marker 写 tree hash，并用 `.deploy-source-kind=git-tree`、`.deploy-release-id=chat-20261007` 区分工作区发布。

源码包来自 Git tree 的 LF blob，只含仓库源码和配置模板，没有实际 `.env`、数据库、`.planning`、构建输出或 node_modules。tar SHA256：`2e3e16e948412a4116b09a824bd9ed5a04a35d40acb6bec5733b00abbc93c226`。

## 顺序与回退材料

1. 在独立源码目录预先构建 `dash-campus:chat-20261007`，原服务继续运行；镜像内隔离库19/19回归通过。
2. 保留原源码包及运行镜像 `dash-campus:rollback-chat-20261007`；只停止 Dash 桥接 timer/service及web/worker，等心跳过期。
3. 停机备份完成：`backups/production-chat-20261007/dash-campus-backup-20261007-115048`；schema35、数据库3145728字节、SHA256 `48b5af004cbeaba99dd76a50f2a892da3753b2a6cdf48644113ebf73ff6f1d85`。
4. 覆盖源码时排除data/backups；保留生产配置。切换镜像，迁移检查报告“已是最新schema35”，启动web/worker、核健康后恢复timer。

新镜像ID `sha256:efdc480e61656f5d7924c34af9fe372d1ce54dfc9596b502fcfec2f49de46d3e`。旧镜像ID `sha256:35f33c76a51abb7e70e9f2432d9168ad9903e93e960ccfe6d08b6aa446efd0e9`，保留回退标签。本次无schema变化；回退代码优先用旧镜像/源码，不为回退界面直接覆盖之后的用户数据。备份包含私人资料，仅在服务器受限目录保存。

## 验证与边界

- 本地全套483/483、build含TypeScript、改动文件eslint通过；桌面/手机/暗色及交互证据见开发复验。
- Linux发布镜像：回答恢复和安排19/19，隔离库、禁网络，没有挂生产数据。
- 生产：478个源码文件与发布包一致，web和worker各475个运行文件一致；web healthy、worker启动正常、恢复0个未知投递/0个孤儿job，health ok/db ok/schema35。
- 生产浏览器：现有主人登录态下，新聊天页显示历史消息、卡片回答关联的后续结果、待答问题与底部输入；聊天→今天→“说一句”浮层→“打开对话页”可走通。
- 没有替主人回答现存问题，没有向生产投递测试材料或修改学习安排。没有触碰Todo数据、服务或配置。
- 发布前桥接service已经failed/exit1；发布后timer active只证明恢复定时器，不能说明桥接已经成功同步。这项单独排查，不是新版本已全系统验收。
- 真实邮件、复杂视觉、真实多设备/新投递模型旅程、主人试用等仍按STATUS列出。部署成功不代表持续Agent优化目标完成。

发布日志、tar与manifest在私人审计目录；开发侧行为/构建日志在忽略的 `.planning`。部署后文档收据是本地补记，未追加到GitHub发布。
