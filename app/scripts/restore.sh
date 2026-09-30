#!/usr/bin/env bash
# 运维脚本：从备份恢复（计划 10.2）。用法: scripts/restore.sh <备份目录>
# 恢复后实例处于暂停：不发邮件、不调用搜索与模型；原数据库改名保留，不删除。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
[ $# -eq 1 ] || { echo "用法: scripts/restore.sh <备份目录>" >&2; exit 2; }
npm run --silent restore -- "$1"
