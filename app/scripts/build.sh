#!/usr/bin/env bash
# 运维脚本：从源码构建（计划 10.1）。用法: scripts/build.sh
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
npm ci
npm run build
echo "构建完成。首次部署：配置 .env → scripts/migrate.sh → scripts/start.sh"
