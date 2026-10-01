# 冒烟脚本共用：后台进程登记与退出清理（source 使用）
# Git Bash 的 $! 是 MSYS pid，taskkill 需要 Windows pid（/proc/<pid>/winpid），否则 node 残留并锁住 smoke 库
# 断言按字符串比较 node 打印的值；FORCE_COLOR 会给数字/布尔加 ANSI 颜色码，导致 "11" != "11"
unset FORCE_COLOR
SMOKE_PIDS=()
SMOKE_PORT=""

smoke_track() { SMOKE_PIDS+=("$1"); }

smoke_kill_tree() { # Linux/macOS：先杀子进程再杀自己（npx → next 是子进程）
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do smoke_kill_tree "$c"; done
  kill "$1" 2>/dev/null || true
}

smoke_kill() { # 结束单个已登记进程（含子进程），跨平台
  if command -v taskkill > /dev/null 2>&1; then
    local w; w=$(cat "/proc/$1/winpid" 2>/dev/null || echo "$1")
    taskkill //F //T //PID "$w" > /dev/null 2>&1 || true
  else
    smoke_kill_tree "$1"
  fi
}

smoke_cleanup() {
  local p w
  if ! command -v taskkill > /dev/null 2>&1; then
    for p in "${SMOKE_PIDS[@]}"; do smoke_kill_tree "$p"; done
    return 0
  fi
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
