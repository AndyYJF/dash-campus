#!/usr/bin/env bash
# 运维脚本：恢复后启用（计划 10.2）。用法: scripts/resume-after-restore.sh [--yes-old-instance-stopped]
# 需要确认旧实例已停止；只重建未来提醒，不补发过去的邮件。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
npm run --silent resume-after-restore -- "$@"
