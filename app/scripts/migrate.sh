#!/usr/bin/env bash
# 运维脚本：迁移（计划 10.1）。用法: scripts/migrate.sh
# 顺序：scripts/stop.sh → scripts/backup.sh <目录> → scripts/migrate.sh → scripts/start.sh
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
npm run --silent migrate
