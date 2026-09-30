#!/usr/bin/env bash
# 运维脚本：停机备份（计划 10.2）。用法: scripts/backup.sh <备份根目录>
# 先 scripts/stop.sh（或 docker compose stop web worker）；脚本检查到服务仍在运行会拒绝。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
[ $# -eq 1 ] || { echo "用法: scripts/backup.sh <备份根目录>" >&2; exit 2; }
npm run --silent backup -- "$1"
