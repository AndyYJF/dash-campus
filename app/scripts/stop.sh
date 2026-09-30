#!/usr/bin/env bash
# 运维脚本：停止 web 与 worker 并确认退出（源码部署）。用法: scripts/stop.sh
# 只按 data/run/*.pid 里记录的 PID 结束，不按进程名批量结束。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
for s in worker web; do
  f="data/run/$s.pid"
  [ -f "$f" ] || { echo "$s 未记录运行中"; continue; }
  pid="$(cat "$f")"
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    if kill -0 "$pid" 2>/dev/null; then echo "$s（PID $pid）30 秒内未退出，请手动检查" >&2; exit 1; fi
  fi
  rm -f "$f"
  echo "$s 已停止"
done
