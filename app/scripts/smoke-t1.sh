#!/usr/bin/env bash
# T1 HTTP 冒烟：setup → login → 401/CSRF/幂等/409 验证。按 PID 启停，不影响其他 node 进程。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-setup-token"
export DATABASE_PATH="./data/smoke-t1.db"
rm -f data/smoke-t1.db data/smoke-t1.db-wal data/smoke-t1.db-shm
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
SMOKE_PORT=3210
npx next start -p 3210 > /tmp/dash-t1-smoke.log 2>&1 &
smoke_track $!
sleep 4

B="http://localhost:3210/api/v1"
pass=0; fail=0
check() { # $1 描述 $2 实际 $3 期望
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}

# 未登录读数据 → 401
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/goals")
check "未登录 GET /goals" "$code" "401"

# 初始化
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-setup-token","password":"smoke-pass-123"}')
check "POST /setup 首次" "$code" "201"
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-setup-token","password":"smoke-pass-123"}')
check "POST /setup 重复 → 409" "$code" "409"

# 登录
login=$(curl -s -c /tmp/dash-cookies.txt -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
csrf=$(echo "$login" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
check "登录返回 csrfToken" "$([ -n "$csrf" ] && echo yes)" "yes"

# 已登录 GET
code=$(curl -s -b /tmp/dash-cookies.txt -o /dev/null -w "%{http_code}" "$B/goals")
check "已登录 GET /goals" "$code" "200"

# 创建缺 Idempotency-Key → 422
code=$(curl -s -b /tmp/dash-cookies.txt -o /dev/null -w "%{http_code}" -X POST "$B/goals" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"title":"x","horizon":"semester"}')
check "创建缺幂等键 → 422" "$code" "422"

# 正常创建 + 幂等重放（同键同体返回同一资源）
body='{"title":"HTTP目标","horizon":"long_term"}'
r1=$(curl -s -b /tmp/dash-cookies.txt -X POST "$B/goals" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -H 'idempotency-key: k1' -d "$body")
r2=$(curl -s -b /tmp/dash-cookies.txt -X POST "$B/goals" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -H 'idempotency-key: k1' -d "$body")
check "幂等重放返回相同 id" "$r1" "$r2"
id1=$(echo "$r1" | sed -E 's/.*"id":"([^"]+)".*/\1/')
count=$(curl -s -b /tmp/dash-cookies.txt "$B/goals" | grep -o "$id1" | wc -l)
check "重放不产生重复资源" "$count" "1"

# 同键不同体 → 409
code=$(curl -s -b /tmp/dash-cookies.txt -o /dev/null -w "%{http_code}" -X POST "$B/goals" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -H 'idempotency-key: k1' -d '{"title":"y","horizon":"semester"}')
check "同幂等键异体 → 409" "$code" "409"

# PATCH 版本冲突 → 409
code=$(curl -s -b /tmp/dash-cookies.txt -o /dev/null -w "%{http_code}" -X PATCH "$B/goals/$id1" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"expectedVersion":99,"title":"z"}')
check "PATCH 版本冲突 → 409" "$code" "409"

# PATCH 正确版本 → 200 且 version=2
v=$(curl -s -b /tmp/dash-cookies.txt -X PATCH "$B/goals/$id1" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"expectedVersion":1,"title":"HTTP目标2"}' | sed -E 's/.*"version":([0-9]+).*/\1/')
check "PATCH 正确版本 → version 2" "$v" "2"

# 变更请求缺 CSRF → 403
code=$(curl -s -b /tmp/dash-cookies.txt -o /dev/null -w "%{http_code}" -X PATCH "$B/goals/$id1" -H 'content-type: application/json' -d '{"expectedVersion":2,"title":"no-csrf"}')
check "变更缺 CSRF → 403" "$code" "403"

# 登出后会话失效
curl -s -b /tmp/dash-cookies.txt -c /tmp/dash-cookies.txt -X POST "$B/auth/logout" > /dev/null
code=$(curl -s -b /tmp/dash-cookies.txt -o /dev/null -w "%{http_code}" "$B/goals")
check "登出后 → 401" "$code" "401"

echo "----"
echo "通过 $pass，失败 $fail"
exit "$fail"
