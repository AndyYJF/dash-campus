# 应用目录补充

适用于 `app/`，继承 [根 AGENTS.md](../AGENTS.md)。如果只打开了应用目录，也先读根规则、[STATUS](docs/STATUS.md) 和 [START-HERE](docs/agent-first-v2/START-HERE.md)。本文件不重复记录当前版本或开发工作包。

- npm 脚本与 `package.json` 在此目录；从仓库根运行时明确指定 `app/`。
- 修改代码前读与改动相关的 `node_modules/next/dist/docs/`；以安装版本的 API 为准。
- 测试数据路径在首次读取配置/数据库前设置，使用独立库，遵守根规则的 Todo 只读边界。
- 下方为 Next.js 管理的框架提示。保留标记块；开发服务会更新它，不能靠删除文件解决重复。

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
