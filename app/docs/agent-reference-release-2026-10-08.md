# 对象澄清与降级修复发布（2026-10-08）

主人明确要求部署，生产已发布 **reference-20261008**。来源为main `feae568`上的本地工作区快照，独立Git tree `8b04e0fff9879a861fd6346b5e2eacd1279ef4d2`，不是GitHub提交；没有commit/push，也没有修改正式Git index。

## 内容与来源

缺失名称或近期指代时列真实候选，选择后恢复原操作；同任务多段按具体学习块选择，不默认取第一段，不扩大来源日期/时段。规则降级不将“别排那么长”“不学英语”等部分否定扩大成全日或长期不学。开发与真实模型证据见[对象澄清报告](agent-reference-clarification-2026-10-08.md)。上一版的复盘读取、短答绑定和跨天范围保护一起保留。

源码包由Git archive取LF blob，不含实际env、数据库、私人原件、node_modules或.planning。tar SHA256 `d212182455ec7a50406f26ac9f44d06947b44918826105060c0f97ed1f379edd`。镜像在独立目录构建，新镜像 `dash-campus:reference-20261008`，ID `sha256:1585c62309060f17d16249aa2329487e87dc6bb74b1d09dbf3174572953cff1e`。

## 停机、备份与回退

Linux镜像相关回归74/74通过后，保存上一版源码，停止Dash桥接timer/service及web/worker，等待心跳过期，成功备份后切换。迁移检查已是最新schema35，没有新增迁移；健康检查成功后恢复桥接timer。没有调整上游地址，没有触碰Todo数据、配置或服务。

备份：`backups/production-reference-20261008/dash-campus-backup-20261008-092756`，schema35，3194880字节，数据库SHA256 `54098d732dc9cc7934340afb3695d5eed517cc7e4747c199497d8801854055b3`，实际文件散列与manifest一致。数据只保存在服务器受限目录。

上一版镜像保留为 `dash-campus:rollback-reference-20261008`，ID `sha256:61e7ff3572ac8d5987caed18b48973cefea8e469b5abd77fbead6d0dc1436ac7`。同schema回退先换旧镜像/源码，不用旧数据库覆盖主人之后的数据。切换脚本在健康失败时会恢复旧镜像及源码。

## 核对结果及边界

- 新镜像生产build和类型检查通过。禁网、不挂生产数据的74项回归通过，含对象选择→确认→实际修改、失效拒绝、原日期范围、降级、复盘、回答恢复与安排。
- 615个生产源码文件与发布包一致；web/worker各477个运行文件一致。web healthy，worker正常启动，恢复0个unknown投递/0个孤儿job；公网health ok/db ok/schema35。timer active不代表已有校园上游故障已解决。
- 本地完整回归504/505，唯一旧录制stale。59条真实重录仍在运行，尚无最终报告，不能标整批通过；已出现u037主动ask与旧act期望的失配，以及u123真实模型45000ms超时导致执行失败。均保留待复核，不把发布成功当整个Agent已完成。
- 生产只读核对，未向生产投递测试、替主人答问题或修改真实安排；本次未新增登录态网页旅程证据。真实视觉、邮件、主人长期试用等边界见[STATUS](STATUS.md)。
- 发布后的这份收据和状态更新仅在本地，不在已部署快照中，也未推送GitHub。持续优化目标保持active，真实模型评测继续使用独立合成库。
