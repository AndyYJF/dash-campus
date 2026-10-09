# 展示模式（演示实例）

更新：2026-10-09。状态：代码、测试与部署文件已在开发分支完成，**尚未部署到服务器**；当前状态以 [STATUS](STATUS.md) 为准。

## 1. 它是什么

给没有账号的人（老师、同学）完整试用 Dash Campus 的入口：

- 正式实例的登录页多一个 **“进入演示模式”** 按钮，点了去演示实例；
- 演示实例不要密码，打开就进，页面、接口、Agent 和正式实例是同一套代码；
- 里面是一位虚构的人工智能专业大二学生“这一周”的数据：课表、作息、任务与学习安排、实践记录、目标与方向、探索候选、通知、复盘建议。可以随便改，每天自动恢复，也能手动恢复。

演示实例是**另一组容器、另一个数据库、另一份环境变量**，和正式实例只共用镜像。正式实例的数据、会话、密钥不会出现在演示实例里。没有在同一个进程里做“访客视图”，因为项目是单用户、单库设计，任何路由疏漏都会把私人数据公开；进程级隔离不依赖逐个接口都写对。

## 2. 访客看到什么

| 入口 | 行为 |
|---|---|
| 正式实例 `/login` | 配了 `DEMO_URL` 时，表单下方出现“进入演示模式”，链接到演示实例。没配时登录页与原来一样 |
| 演示实例任意页面 | 没有会话时转到 `/login`，自动领一个访客会话后回到原页面，不需要点任何东西 |
| 页面顶部的演示条 | 说明这是合成数据、每天几点恢复、当天全站 AI 余量；“体验指引”给六句可以直接交给 Agent 的话和各页面说明；“恢复示例数据”手动恢复 |

所有访客**共用**这一份数据，同时在线的人会看到彼此的改动和对话。这是为了不改动单库架构做的取舍，演示条上写明了。

## 3. 示例数据

`src/workflows/demo-seed.ts`，由恢复流程在一个事务里调用。

- 全部是编出来的：课程、老师、地点、通知都不对应真实的人和学校。
- 日期从“今天”推算：学期首周周一在五周前，截止日、实践记录、固定活动围绕本周，哪天恢复都像当周的数据。
- 业务对象走注册过的业务操作（`executeCommand`，与 Agent 和按钮同一条路），课表投影、提醒、变更记录由操作产生，学习块由同一个重排算法排出。
- 模型产出的东西（探索候选、复盘观察与建议）是事先写好的，没有调用模型，`integration_mode` 记为 `fixture`，页面上标“示例数据”。
- **AI 资讯不写假新闻**：没有可用盘点时排一次更新，由 worker 按订阅源和真实模型生成；已生成的盘点在恢复时保留。

改了示例内容就把 `DEMO_SEED_VERSION` 加一，已部署的演示实例会在 worker 下一趟轮询时自动恢复成新版。

## 4. 恢复（重置）

`src/workflows/demo.ts` 的 `resetDemoData`：一个 `IMMEDIATE` 事务里清空业务表 → 放回迁移自带的默认行 → 重新写入示例。web 和 worker 要么看到旧数据，要么看到完整的新示例。一次约 0.2 秒。

| 触发 | 说明 |
|---|---|
| 每天 `DEMO_RESET_HOUR` 点（默认 04:00，实例时区） | worker 在两趟任务之间执行 |
| 页面上的“恢复示例数据” | 任何访客都能点，两次之间至少隔 5 分钟 |
| 示例版本变化、数据库超过 400 MB | worker 自动执行 |
| `docker compose -f compose.demo.yaml up` | 每次启动先迁移并恢复 |

恢复时**保留**：访客会话（不踢人）、当天的 AI 调用账目（不能靠恢复刷新额度）、模型端点探测结论、最近两期资讯盘点。

## 5. 公开匿名访问的护栏

| 风险 | 处理 |
|---|---|
| 演示模式被指到正式库（私人数据免登录公开） | 演示库带标记（`settings.demoInstance`，只由恢复流程写入）。`DEMO_MODE=1` 的 web/worker 连到没有标记的库**拒绝启动**；恢复与建库命令遇到“已有主人但没有标记”的库**拒绝执行**；反过来普通模式连到演示库也拒绝启动。`compose.demo.yaml` 把 `DEMO_MODE` 和数据库路径写死 |
| 花光模型额度 | 全站每日上限 `DEMO_DAILY_MODEL_CALLS` / `DEMO_DAILY_SEARCH_CALLS`，在读取预算时封顶：访客在设置页或对话里调高不会超过。用完后 AI 入口暂停到第二天，其余功能照常 |
| 一个人短时间刷接口 | 写入与 AI 请求按访客会话和来源地址限速（10 分钟窗口，`src/domain/demo.ts`），领会话也限速 |
| 碰到实例之外 | 关闭：发测试邮件、重发邮件、旧工具导入、签发外部推送口令、重新探测模型端点。`resolveMailer()` 在演示模式下恒为未配置。URL 抓取沿用既有的私网地址防护 |
| 影响别的访客 | 不能撤销别人的会话，会话列表只显示自己的 |
| 密码与初始化 | 主人记录的密码摘要是随机串，登录与初始化接口在演示模式下返回 403 |
| 磁盘 | 每天恢复；数据库超过上限提前恢复并回收空间 |

关掉的入口返回 `403 DEMO_DISABLED` 和一句说明，页面按普通错误显示。任务、课表、安排、探索、复盘、资讯、方向、导出等业务功能全部保留。

没有处理的：访客可以把模型当普通聊天用（受每日上限约束）；访客写的内容其他访客看得到，直到下一次恢复。

## 6. 部署

前提：正式实例已按 [deploy.md](deploy.md) 用 Compose 部署，镜像 `dash-campus:local` 是包含本功能的版本。

```bash
cd /opt/dash-campus

# 1. 演示实例的环境变量：建议给演示单独申请一个有额度上限的模型 key
cp .env.demo.example .env.demo && chmod 600 .env.demo
#    填 APP_BASE_URL（演示地址）、MODEL_*；按需改 DEMO_PORT、每日上限

# 2. 数据目录属主与正式实例一样是容器用户 uid 1000
mkdir -p data-demo && chown 1000:1000 data-demo && chmod 700 data-demo

# 3. 启动：先建库并写入示例，再起 web + worker
docker compose -f compose.demo.yaml up -d
curl -s "http://127.0.0.1:3001/api/v1/demo"      # {"demo":true,...}

# 4. 反向代理：给演示实例一个地址（下面二选一），改前备份 Caddyfile，caddy validate 通过后 reload
# 5. 正式实例 .env 加 DEMO_URL=<演示地址>，然后 docker compose up -d web（只重建 web，不需要迁移或停机备份）
```

演示地址两种给法：

```caddyfile
# A. 子域名（推荐）：先在域名解析里加一条 demo 的 A 记录指向同一台服务器
demo.example.org {
    reverse_proxy 127.0.0.1:3001
}

# B. 不想加解析：同一个域名换端口（需要在防火墙放行 8443）
dash.example.org:8443 {
    reverse_proxy 127.0.0.1:3001
}
```

两种都可以：演示实例的会话 Cookie 叫 `dash_demo_session`，和正式实例的 `dash_session` 不同名，同域不同端口也不会互相覆盖。

### 升级

演示实例和正式实例共用镜像，正式实例升级后顺手重建演示实例即可；演示数据可随时重建，**不需要备份**：

```bash
docker compose -f compose.demo.yaml down
docker compose -f compose.demo.yaml up -d      # seed 服务先迁移并恢复示例
```

### 关掉演示

正式实例 `.env` 去掉 `DEMO_URL` 并重建 web（按钮消失）；`docker compose -f compose.demo.yaml down` 停掉演示实例。`data-demo/` 可以直接删除。

### 源码方式（本地试跑）

```bash
export DEMO_MODE=1 DATABASE_PATH=./data-demo/demo.db MODEL_PROTOCOL=fake SEARCH_PROVIDER=fake
scripts/demo-seed.sh          # 建库 + 示例；没有 DEMO_MODE=1 时拒绝执行
npx next dev -p 3001          # 另开一个终端：npm run worker
```

`MODEL_PROTOCOL=fake` 是规则桩，只够走通流程，Agent 对话需要真实模型。

## 7. 环境变量

| 变量 | 配在哪 | 说明 |
|---|---|---|
| `DEMO_URL` | 正式实例 `.env` | 演示实例的地址；有值时登录页出现入口 |
| `DEMO_MODE` | 演示实例（compose 已写死） | `1` 开启；不要在正式实例上设置 |
| `DEMO_DAILY_MODEL_CALLS` | 演示实例 `.env.demo` | 全站每日模型请求上限，默认 300 |
| `DEMO_DAILY_SEARCH_CALLS` | 同上 | 全站每日搜索请求上限，默认 20 |
| `DEMO_RESET_HOUR` | 同上 | 每天恢复的钟点，默认 4 |

## 8. 代码地图

| 文件 | 内容 |
|---|---|
| `src/domain/demo.ts` | 开关、关闭的入口清单、限速（纯函数与进程内计数） |
| `src/workflows/demo.ts` | 演示标记、启动检查、恢复、每日维护、公开状态、worker 启动时的端点探测 |
| `src/workflows/demo-seed.ts` | 合成示例数据 |
| `src/workflows/auth-guard.ts` | `requireOwner` 里接入关闭清单与写入限速（所有业务接口的共同入口） |
| `src/app/api/v1/demo/` | `GET` 公开状态、`POST enter` 领访客会话、`POST reset` 手动恢复 |
| `src/app/login/page.tsx`、`src/app/components/DemoBar.tsx`、`demoStatus.ts` | 登录页入口与自动进入、演示条与体验指引 |
| `src/scripts/demo-seed.ts`、`scripts/demo-seed.sh` | 建库/恢复命令（`npm run demo:seed`） |
| `compose.demo.yaml`、`.env.demo.example` | 演示实例的部署 |
| `test/demo-mode.test.ts` | 10 项行为测试 |

没有新迁移：演示标记和保留项都在已有的 `settings` 表里，schema 仍是 36。

## 9. 验证边界

见 [STATUS](STATUS.md) 的展示模式一节。要点：隔离测试、本地网页与 Docker 镜像已验证；**真实模型下的演示对话、服务器部署、反向代理与正式站登录页按钮的线上效果还没有验证**。
