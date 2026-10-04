# 部署、迁移、备份与恢复

Dash Campus 是单用户自部署应用：一个镜像两个进程（web、worker），数据是一个 SQLite 文件，放在 `data/` 持久目录。

当前状态与接手入口见 [STATUS](STATUS.md)。2026-10-04只读审计的数据库版本为 **23**；实际部署时以目标代码 EXPECTED_SCHEMA_VERSION、迁移和当前运行状态核对，不把schema16旧发布当当前要求。schema16发布/回退和Web V1说明保留为 [历史状态](web-v1-status-2026-10-03.md) 与 [Web V1交付记录](web-v1-final-acceptance-2026-10-03.md)，旧工具映射见 [兼容说明](legacy-compatibility-2026-10-03.md)。原文提取与摘要通知由 worker 执行，只有 web 时会一直排队；摘要默认关闭，需要按已确认策略启用。升级前先停机备份，不能用旧镜像连接迁移后的新库。下文带历史日期的生产记录保留当时边界，不等于当前可直接回退。

已安装校园桥接的实例，**升级、备份、恢复前须先停止 `dash-campus-campus-bridge.timer` 和对应 `.service`，再停止 web/worker**。桥接也是数据库写入者，不能只停 Compose 后宣称完全停机。启动正常并确认非恢复暂停后再启动 timer；恢复时所有旧实例及其桥接必须停止，人工核对并执行 resume 后才启动 worker/timer。

## 1. 配置

复制 `.env.example` 为 `.env`，至少填：

| 键 | 说明 |
| --- | --- |
| `APP_BASE_URL` | 对外地址（邮件里的链接用），如 `https://dash.example.org` |
| `APP_TIMEZONE` | 实例时区，默认 `Asia/Shanghai` |
| `SETUP_TOKEN` | 一次性初始化口令，初始化完成后不再生效 |
| 模型 / 搜索 / SMTP | 可选；未配置时页面显示“未配置”，基础计划与记录照常可用 |

`.env` 只放在服务器上，不要提交到仓库，也不要放进镜像（`.dockerignore` 已排除）。界面只显示“是否已配置”，不回显密钥。

## 2. 用 Docker Compose 部署（推荐）

```bash
docker compose build
docker compose --profile ops run --rm ops scripts/migrate.sh   # 首次与每次升级
docker compose up -d                                           # 启动 web + worker
```

- web 在容器内监听 `0.0.0.0:3000`，Compose 只映射到宿主 `127.0.0.1:${DASH_PORT:-3000}`，不直接暴露公网。宿主 3000 被占用时在 `.env` 设 `DASH_PORT`。
- 数据目录属主必须是容器用户 uid 1000：`chown 1000:1000 data backups && chmod 700 data backups`，否则启动报 `SQLITE_CANTOPEN`。
- 数据在宿主 `./data`，备份目录 `./backups`（只由 ops 容器挂载）。
- 浏览器打开后进入 `/setup`，输入 `SETUP_TOKEN` 和主人密码完成初始化。

### HTTPS 反向代理示例（Caddy，装在宿主上）

```caddyfile
dash.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

如果反向代理也跑在容器里，让它和 web 共享网络并转发到 `web:3000`，不要写 `127.0.0.1`（那是代理容器自己）。

## 3. 从源码部署

需要 Node.js 24。

```bash
scripts/build.sh      # npm ci + next build
scripts/migrate.sh
scripts/start.sh      # 启动 web(127.0.0.1:3000) 与 worker，PID 在 data/run/，日志在 data/logs/
scripts/stop.sh       # 按记录的 PID 停止并确认退出
```

`PORT` 和 `HOSTNAME_BIND` 环境变量可改监听地址。`scripts/start.sh web` 只启动 web。

## 4. 升级与迁移

迁移只由独立命令执行。web 和 worker 启动时只检查 schema 版本：版本不符就退出并提示，不会自己改表。

```text
停止 web/worker → 备份 → migrate → 启动
```

```bash
# Compose
docker compose stop web worker
docker compose --profile ops run --rm ops scripts/backup.sh /app/backups
docker compose build
docker compose --profile ops run --rm ops scripts/migrate.sh
docker compose up -d

# 源码
scripts/stop.sh && scripts/backup.sh ../backups && git pull && scripts/build.sh && scripts/migrate.sh && scripts/start.sh
```

### 生产（服务器上不是 git 仓库）：用 GitHub 源码包升级

2026-09-30 实际走通的顺序。`<SHA>` 用要上线的 `main` 提交的完整 SHA。

```bash
cd /opt/dash-campus
SHA=<SHA>
# 0. 服务还在跑时先下载，缩短停机时间
curl -fsSL "https://codeload.github.com/AndyYJF/dash-campus/tar.gz/$SHA" -o "/tmp/dash-$SHA.tgz"
# 1. 停机 → 备份：必须看到"备份完成"才能继续
docker compose stop web worker
docker compose --profile ops run --rm ops scripts/backup.sh /app/backups
# 2. 覆盖源码：包里没有 .env、data/、backups/，这三样不动
tar -xzf "/tmp/dash-$SHA.tgz" --no-same-owner --strip-components=2 -C /opt/dash-campus "dash-campus-$SHA/app"
# 3. 构建 → 迁移 → 启动 → 核对
docker compose build
docker compose --profile ops run --rm ops scripts/migrate.sh
docker compose up -d web worker
curl -s "http://127.0.0.1:${DASH_PORT}/api/v1/health"
```

注意：

- 不要在交互式 SSH 里执行 `set -e`：任何一条命令失败都会让整个登录 shell 退出，重新登录后变量丢失。
- 备份失败时停下来看原因，不要继续覆盖源码或迁移。服务已停时想先恢复，直接 `docker compose up -d web worker`（旧镜像、旧库都没动）。
- 2026-09-30 之前构建的镜像里，备份检查会把反向代理的 502 当成"web 仍在运行"而拒绝备份。用这类旧镜像备份时，临时把检查地址指向 web 容器本身：`docker compose --profile ops run --rm -e APP_BASE_URL=http://web:3000 ops scripts/backup.sh /app/backups`（web 停止时 `web` 在 compose 网络里解析不到，检查放行；web 在运行时照样拒绝）。修复后的镜像不需要这一步。
- `.env not found. Continuing without it.` 可以忽略：ops 容器的变量已由 compose 的 `env_file` 注入。
- 停止 web/worker 后至少等 25 秒再备份：worker 心跳 20 秒内仍视为在运行，备份会拒绝。
- 用 `bash -s` 等方式把整段脚本经 stdin 交给服务器执行时，`docker compose run` 必须加 `-T` 并 `</dev/null`，否则它会吞掉后续脚本，留下“已停机未升级”的半程状态。长步骤宜用 `nohup` 在服务器端执行，避免 SSH 断开中止构建。
- 本地核对源码散列时用 `git -c core.autocrlf=false archive <SHA>`；开启 autocrlf 的 Windows 克隆会改写换行，与 GitHub 源码包不一致。

## 5. 备份（停机）

```bash
scripts/stop.sh
scripts/backup.sh <备份根目录>
scripts/start.sh
```

- 备份前脚本会检查 worker 心跳和 web 健康端点，还在运行就拒绝。
- 用 SQLite 备份接口写出一个完整的数据库文件（包含 WAL 里已提交的内容），不直接复制正在写入的主文件。
- 产物：`<根目录>/dash-campus-backup-<时间>/`，含 `dash-campus.db` 与 `manifest.json`（schema 版本、应用版本、时间、sha256）。
- 备份包含全部个人数据，放在只有你能读的位置。导出缓存不需要备份。

## 6. 恢复

恢复默认暂停所有外部动作，因为旧备份不知道备份之后哪些邮件已经发出。

```bash
scripts/stop.sh
scripts/restore.sh <备份目录>          # 校验 hash → 原库改名保留 → 复制 → 必要时迁移 → 进入恢复暂停
scripts/start.sh web                   # 只启动 web，登录核对数据
# 确认旧实例（包括别的机器上的）web/worker 都已停止
scripts/resume-after-restore.sh        # 交互确认；非交互加 --yes-old-instance-stopped
scripts/start.sh worker
```

恢复暂停期间：

- 页面顶部显示“实例已从备份恢复，外部动作已暂停”。
- worker 不领取任何任务，不发邮件，不调用搜索或模型；测试邮件、探索、复盘、卡点分析入口返回 503。
- 备份时“提交中”的投递标为“结果未确定，可能已发送”，不会自动重发。

`resume-after-restore` 做的事：

- 取消恢复出来的所有旧后台任务。
- 按当前任务重建**触发时间晚于现在**的提醒。触发点已过的提醒只在“今日待处理”里显示，不补发。
- 定期探索和定期周复盘从下一个周期开始，不补跑恢复期间错过的周期。

原数据库改名为 `dash-campus.db.pre-restore-<时间>` 保留，不会删除。确认无误后可以自己手动清理。回退到恢复前的状态也走同一流程（把保留的文件当作备份来源）。

## 7. 数据导出

在网页里操作，不需要停机：

- 设置 → 数据导出：全量 JSON。包含个人业务数据并保留关联 ID，不含密码、会话、集成凭证和后台投递队列。
- 项目页 → 阶段报告：先选内容和记录，再预览、编辑 Markdown，最后导出。只包含选中的内容。

导出文件保存在 `data/exports/`，24 小时后过期（下载返回 410）。

## 8. 验证状态

| 项目 | 状态 |
| --- | --- |
| 源码构建、迁移、启动、停止、备份、恢复、恢复后启用 | 本机（Windows + Git Bash）按脚本实测，见 `scripts/smoke-t7.sh` |
| Dockerfile / compose.yaml | 2026-09-29 在生产服务器（Debian 13、Docker 26.1、Compose 2.26）构建运行通过 |
| HTTPS 反代 | 生产复用宿主 Caddy 2.6，证书签发与跳转已验证（域名不入库） |
| 生产部署 | 2026-09-29 已部署（主机与域名不入库，见第 9 节） |

## 9. 当前生产实例

主机地址、域名、SSH 公钥不入库。部署形状如下：

| 项目 | 值 |
| --- | --- |
| 目录 | `/opt/dash-campus`（`.env` 600 root，`data/` 700 uid 1000） |
| 进程 | `docker compose` 的 `web`、`worker`，`restart: unless-stopped` |
| 端口 | web 只映射 `127.0.0.1:${DASH_PORT}`（宿主 3000 被占用时改这个变量） |
| HTTPS | 宿主已有的 Caddy，在 Caddyfile 末尾追加独立站点块（改前备份），Let's Encrypt 自动续期 |
| SMTP | 该主机出站 465 不通，改用 `587` + `explicit`（STARTTLS），2026-09-30 主人已验证真实发送 |
| 初始化 | 2026-09-29 主人已完成；`SETUP_TOKEN` 已清空 |
| 部署密钥 | 本机专用密钥，公钥用 `DEPLOY_PUBKEY` 传给 `scripts/server-add-deploy-key.sh`，不写进仓库 |

常用命令（在服务器上）：

```bash
cd /opt/dash-campus
docker compose ps
docker compose logs -f --tail 50 web worker
docker compose stop web worker && docker compose --profile ops run --rm ops scripts/backup.sh /app/backups && docker compose up -d web worker
```

升级：把新源码覆盖到 `/opt/dash-campus`（保留 `.env`、`data/`、`backups/`；解压后 `chown -R root:root` 源码、`chown 1000:1000 data backups`）→ 按第 4 节执行。

核对本地与生产源码一致（两边各算一次，结果相同即一致）：

```bash
find src migrations scripts package.json package-lock.json Dockerfile compose.yaml -type f | xargs sha256sum | sed 's/ \*/  /' | LC_ALL=C sort | sha256sum
```

