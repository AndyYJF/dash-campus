# 旧 ToDo 迁移和校园插件桥接

本轮交付：同机 SQLite 只读快照工具、设置页预览和确认导入、来源 ID 映射、导入结果下载、单向校园通知桥接。数据库版本 **16**，已生产发布 `20261003-d71ea0f546d3`。真实 243 条任务及 1 个项目已迁移，220 条插件通知已接入，204 条已有任务关联；详见 [最终交付记录](web-v1-final-acceptance-2026-10-03.md)。旧工具保留供查阅，不写回、不停用。

## 1. 已核对的旧协议

参考源码固定到：

- [todo-web f990612](https://github.com/AndyYJF/todo-web/tree/f9906122e422c7f6161800de041ced4863d1a1c4)：`lib/db.ts`、`lib/types.ts`、`lib/campus-sync.ts`、`lib/datetime.ts`。
- [campus-inbox 0b34dc7](https://github.com/AndyYJF/astrbot_plugin_campus_inbox/tree/0b34dc7da7242a0ed232f91a0eef5930e6539fac)：`campus/storage.py::todo_tasks` 和 `campus/web.py`。

同机旧数据库的列已通过只读连接核对。初期开发使用隔离示例；本次实际迁移在服务器生成私有一致快照，由生产设置页预览并确认。旧 `.env`、插件 token 及数据库未下载到本地；浏览器核对实际任务内容。私有配置只在服务器权限受限目录备份。

旧 ToDo 是一个 `tasks` 表；`project` 是分组字符串，没有独立项目表。日期是 `YYYY-MM-DD HH:mm`，没有时区。插件接口是 `GET /api/todo/v1/tasks?status=all`，接受 Bearer token；每个来源原文最多返回 500 字，`open` 合并了 `active` 和 `needs_review`。

## 2. 映射规则

| 旧字段 | 新行为 |
|---|---|
| id | `(实例 sourceId, task, 旧 id)` 唯一映射；重导不重复创建 |
| project | 非空分组生成项目；按完整原分组建立映射，不根据名称合并既有新项目 |
| done | 0→todo，1→done；旧同步可能把 cancelled 也记为 done，报告提示并保留上游 ID，不能凭旧库还原取消 |
| title / note | 展示字段限 200 / 5000 字，超限在预览明确提示；完整脱敏字段保存在来源记录 |
| priority | high→high，normal→normal，low→normal 并提示保留原级别 |
| due_at | 按主人确认的旧时区转换为 UTC instant；非法日期、未知格式或 DST 歧义留空并提示原值仍保留 |
| start_at | 保留旧时间窗口，不转成执行排程；未完成任务放入待安排 |
| created_at / updated_at / done_at | 支持的旧日期转换并保留；完成日未知时留空，不把导入日算成本周成果 |
| quick / pinned | 保留在来源记录；不制造新平台置顶状态 |
| external_id / external_rev | 保留校园事项关联，绑定来源后与后续修订关联 |

导入前移除 URL userinfo、token/key/signature 等查询参数及常见明文凭证。受保护图片可能不能再直接打开；本轮不迁移附件、不保存旧图片 token，需在旧工具查看附件。脱敏有明确范围，不保证识别任意自由文本中的所有秘密，主人仍应核对预览和导出内容。

## 3. 同机迁移流程

新版本发布后执行，旧服务不需要停止。只读 SELECT 放在一致读事务内，兼容 WAL；不能直接 `cp todo.db` 忽略 WAL。仅挂载旧数据目录给一次性快照容器，不给常驻 web/worker 增加旧库访问权。

先将下面内容保存为管理员脚本，替换两个示例目录，再运行脚本：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /srv/dash-campus
# 替换为旧 ToDo 持久目录；容器只读挂载，快照命令不会加载旧环境文件。
docker compose run --rm --no-deps --user 0 \
  -v /srv/old-todo/data:/legacy:ro web \
  npm run legacy:snapshot -- \
  --db /legacy/todo.db \
  --out /app/data/legacy/todo.snapshot.json \
  --source todo-main --timezone Asia/Shanghai
# 镜像默认 web 用户 uid1000；确保它能读取刚生成的私有快照。
chown 1000:1000 data/legacy data/legacy/todo.snapshot.json
chmod 700 data/legacy
chmod 600 data/legacy/todo.snapshot.json
```

工具只投影已核对业务列，不导出旧配置；缺少后加的 pinned/external 列按默认值读取。不存在的库、必要字段缺失、超过5000条或10 MiB时失败，不截断数据，不创建旧数据库。

随后在 **设置 → 旧 ToDo 迁移**：

1. 如需插件后续接入，先在“通知来源”创建校园来源并保存一次显示的导入 token。
2. 点击“读取服务器快照”，也可选择该工具生成的 JSON；不支持任意 JSON 或 SQLite 文件上传。
3. 首次确认旧库时区与校园来源绑定。这两项之后固定；再次载入自动沿用已确认配置，不能借重导改时区或换来源。`sourceId` 是旧实例的长期标识，不能每次另取名字规避去重。
4. 默认不创建邮件提醒。主人可选择为新导入的未完成任务建立未来提醒；无论如何都不补发过去的提醒。后续改截止/提前量或重开任务按普通规则生成提醒。
5. 生成预览，核对记录数、项目、状态、截止、提示和冲突；可下载预览报告。
6. 勾选确认并导入。只创建预览里的新记录；冲突保持现状。源数据或目标版本在预览后变化时整批拒绝，要求重新预览。
7. 下载结果与新旧 ID 映射，去计划的“待安排”与对应项目核对。重复相同确认请求返回原结果，不产生第二份数据。

再次生成快照并预览：相同来源记录跳过；来源字段变化为冲突，不覆盖主人修改；目标物理删除后不自动复活。若旧平台后来删除记录，本次导入也不会删除新平台记录。修改过的历史记录不提供自动覆盖合并：保留冲突报告，主人对照新平台任务人工处理。

首次导入前要按部署说明备份**新平台**数据库。本次已完成备份和真实导入，初始提醒选项保持关闭，没有补发过去提醒。核对实际数据并由主人确认切换后才停用旧入口；目前旧服务保持运行，便于查阅附件。

## 4. 校园插件桥接

桥接是独立单次轮询 CLI，不占用 Web 请求做长任务。上游保持不变；不回写状态。全量请求 `status=all`，失败返回非零，下次全量重试；新平台按来源 ID + 事项 ID + revision 去重，因此不用容易丢项的增量游标。

私有环境文件模板见 `.env.campus-bridge.example`。不要将真实文件放入 Git。源地址与 token 分开保存，网络请求用 Authorization Bearer，不把凭证放 URL。客户端关闭重定向，避免携带 token 跟随跳转。

本机 Node24 安装依赖后，保存 `.env.campus-bridge` 并执行脚本：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /srv/dash-campus/app
npm run legacy:campus-bridge
```

Docker/Linux 部署可用一次性镜像运行，私有环境文件位于宿主机（以下 host network 仅适用于上游/目标在宿主环回的情况）：

```bash
#!/usr/bin/env bash
set -euo pipefail
docker run --rm --network host \
  --env-file /etc/dash-campus/campus-bridge.env \
  dash-campus:local npm run legacy:campus-bridge
```

Linux 配套文件为 `host/campus-bridge-run.sh`、`host/dash-campus-campus-bridge.service` 与 `.timer`。本次生产已启用独立 10 分钟 timer，并验证周期触发成功；oneshot service 避免自身重叠。不要另行启动并行轮询。私有配置为 `/etc/dash-campus/campus-bridge.env`（root、600），桥接只输出任务 ID 及统计/HTTP 状态，不打印 token 或业务正文。停止、备份、恢复时也要停止 timer 和 service，恢复暂停未解除时不要重启桥接。

桥接传到 `/api/v1/legacy/campus` 后：

- 原文节选、旧摘要、标题、上游状态分别标明。AI **仅接收原文节选**，逐字证据也只在节选中验证，旧模型推断不成为资格证据。
- 原文缺失时待确认，不调用模型；原始消息时间缺失或多个来源时间不同，不用事项更新时间定位“明天”，没有可靠锚点的截止需人工确认。
- 插件的完成/取消只更新来源版本，绝不替主人完成或取消任务；原接口不能区分 active / needs_review，不能把 open 当符合资格。
- 新版本不覆盖已经关联的任务。第一次关联已迁移任务后，来源正文变化仍进入现有差异提醒；没有行动草案时详情也显示已关联任务。需主人对照上游状态做判断。
- 新事项进入收件箱，按既有原文提取/身份三值规则处理；不会自动创建正式任务。只有上游 open 事项自动触发模型，completed/cancelled 历史保留并可手工提取，避免全量历史导入造成模型调用洪峰。
- 相同 revision 但不同正文返回409，要求核对上游修订，不偷偷用内容哈希绕过版本错误。
- 原文节选可能不完整；本次已验证 4 条真实 open 事项的模型处理，但不代表完整消息或任意通知的判断质量。图片及没有可靠时间锚点的相对日期保留待确认；未迁移全部原始群消息。

收件箱分页加载，不再把总历史截在 200 条；上游已结束的事项默认收起，可展开查阅。身份“入学年份”和“当前年级”分开存储，不根据入学年份推测年级；专业、校区或奖助资格未确认时保留 UNKNOWN。

## 5. API / schema /验证

| 接口 | 语义 |
|---|---|
| GET /api/v1/legacy | 主人登录；最近10份结果、已固定实例绑定及可用来源，不返回 token |
| GET /api/v1/legacy?server=1 | 主人登录；读取数据库同级 legacy/todo.snapshot.json，路径固定，不接受任意文件路径 |
| POST /api/v1/legacy/preview | 登录+CSRF；只读预览，不创建业务记录 |
| POST /api/v1/legacy/apply | 登录+CSRF+Idempotency-Key+confirm；指纹复核和写入在同一个IMMEDIATE事务 |
| GET /api/v1/legacy/imports/:id/download | 主人登录，下载持久导入结果，不触发重新生成；private/no-store |
| POST /api/v1/legacy/campus | 来源 token；实际插件字段适配、修订去重、已迁移任务关联 |

迁移15添加 legacy_instances、legacy_mappings、legacy_imports，以及 inbox_revisions 的 extraction_text / extraction_occurred_at。来源记录与主人字段分开保存；全量业务 JSON 导出包含脱敏来源、映射与导入结果，常规 SQLite 备份自然包含它们。

已执行：原有109项加本轮13项行为测试均通过，类型检查、lint和生产构建通过。新增覆盖真实结构SQLite只读快照、时区/历史完成、重复/冲突/过期确认、凭证脱敏、提醒选择、归档父项目、来源绑定、桥接原文隔离、登录/CSRF/幂等重试与请求上限。独立 CLI 子进程通过 HTTP 模拟插件调用实际兼容 route，验证部分失败重试、重复重放和相同修订碰撞；这是模拟端点，不是真实插件联调。

隔离浏览器：服务器快照和手工JSON都可加载；3条任务/2个分组首次导入5条，刷新后重导跳过5条；主人编辑和旧源变化后预览为跳过4、冲突1，显示双方内容，保留主人记录。结果文件和预览文件均实际下载并核对JSON内容及无示例凭证。内置浏览器未对Blob下载返回完成事件，文件内容已在本地核对；持久结果使用服务器附件下载接口。1440px桌面、390px/320px窄屏未见横向溢出；计划待安排区显示导入任务与正确项目；通知详情在没有行动草案时仍显示已关联任务及来源变化，模拟的取消修订不会改变原任务状态。

后续实际完成：schema14→15 生产升级、243 条旧任务与 1 个项目导入、220 条真实插件通知轮询、204 条已有任务关联、4 条真实 open 事项模型提取、10 分钟定时器及重复轮询验证。schema15阶段全套自动测试为136项；最终schema16为149项通过；类型检查、lint 与 Linux 构建通过。生产浏览器已验证 100→200→220 条分页、历史展开与关联任务保留；隔离恢复保留 43 张业务表记录数。尚未执行旧入口停用、新测试邮件发送与实际收件确认。Android通知/小组件及离线同步不在本轮范围。
