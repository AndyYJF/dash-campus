#!/usr/bin/env bash
# 运维脚本：启动 web 与 worker（源码部署；Docker 部署用 docker compose up -d）。
# 用法: scripts/start.sh [web|worker|all]   默认 all
# 进程 PID 写在 data/run/，日志在 data/logs/。服务只检查 schemaVersion，不改表。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
what="${1:-all}"
case "$what" in web|worker|all) ;; *) echo "用法: scripts/start.sh [web|worker|all]" >&2; exit 2 ;; esac
mkdir -p data/run data/logs
PORT="${PORT:-3000}"
HOSTNAME="${HOSTNAME_BIND:-127.0.0.1}"

running() { [ -f "data/run/$1.pid" ] && kill -0 "$(cat "data/run/$1.pid")" 2>/dev/null; }

if [ "$what" != "worker" ]; then
  if running web; then echo "web 已在运行（PID $(cat data/run/web.pid)）"; else
    nohup npx next start -H "$HOSTNAME" -p "$PORT" >> data/logs/web.log 2>&1 &
    echo $! > data/run/web.pid
    echo "web 已启动：http://$HOSTNAME:$PORT（PID $!，日志 data/logs/web.log）"
  fi
fi
if [ "$what" != "web" ]; then
  if running worker; then echo "worker 已在运行（PID $(cat data/run/worker.pid)）"; else
    nohup npm run --silent worker >> data/logs/worker.log 2>&1 &
    echo $! > data/run/worker.pid
    echo "worker 已启动（PID $!，日志 data/logs/worker.log）"
  fi
fi
sleep 3
for s in web worker; do
  if [ -f "data/run/$s.pid" ] && ! running "$s"; then
    echo "$s 启动后已退出，请查看 data/logs/$s.log（常见原因：schema 版本不符，需要 scripts/migrate.sh）" >&2
    rm -f "data/run/$s.pid"
    exit 1
  fi
done
