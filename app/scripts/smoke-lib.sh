# 冒烟脚本共用：后台进程登记与退出清理（source 使用）
# Git Bash 的 $! 是 MSYS pid，taskkill 需要 Windows pid（/proc/<pid>/winpid），否则 node 残留并锁住 smoke 库
SMOKE_PIDS=()
SMOKE_PORT=""

smoke_track() { SMOKE_PIDS+=("$1"); }

smoke_cleanup() {
  local p w
  for p in "${SMOKE_PIDS[@]}"; do
    w=$(cat "/proc/$p/winpid" 2>/dev/null || echo "$p")
    taskkill //F //T //PID "$w" > /dev/null 2>&1 || true
  done
  # 兜底：按端口杀仍在监听的进程
  if [ -n "$SMOKE_PORT" ]; then
    for p in $(netstat -ano | awk -v port=":$SMOKE_PORT" '$2 ~ port"$" && /LISTENING/ {print $5}' | sort -u); do
      taskkill //F //T //PID "$p" > /dev/null 2>&1 || true
    done
  fi
}
trap smoke_cleanup EXIT
