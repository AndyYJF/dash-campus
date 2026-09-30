#!/usr/bin/env bash
# T2 HTTP 冒烟：任务→记录→改期提案→原子应用 全闭环
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-t2-token"
export DATABASE_PATH="./data/smoke-t2.db"
rm -f data/smoke-t2.db data/smoke-t2.db-wal data/smoke-t2.db-shm
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
SMOKE_PORT=3211
npx next start -p 3211 > /tmp/dash-t2-smoke.log 2>&1 &
smoke_track $!
sleep 4

B="http://localhost:3211/api/v1"
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}

curl -s -o /dev/null -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-t2-token","password":"smoke-pass-123"}'
login=$(curl -s -c /tmp/dash-t2-cookies.txt -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
csrf=$(echo "$login" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')

# 建项目
proj=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/projects" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -H 'idempotency-key: p1' -d '{"title":"探索项目","question":"验证什么","expectedOutcome":"","prerequisites":"","reviewQuestions":""}')
pid=$(echo "$proj" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check "创建项目 201" "$([ -n "$pid" ] && echo yes)" "yes"

# 建任务（归属本周）
task=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/tasks" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -H 'idempotency-key: t1' -d "{\"title\":\"写实验\",\"projectId\":\"$pid\",\"estimateMinutes\":90,\"plannedWeek\":{\"localMonday\":\"2026-09-28\",\"timezone\":\"Asia/Shanghai\"},\"due\":{\"kind\":\"date\",\"localDate\":\"2026-09-30\",\"timezone\":\"Asia/Shanghai\"}}")
tid=$(echo "$task" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check "创建任务" "$([ -n "$tid" ] && echo yes)" "yes"

# 写日志（同 clientEntryId 重放）。Git Bash 命令行直接传中文会被转码，改用文件传输
logbody=$(mktemp)
printf '%s' '{"clientEntryId":"draft-a","occurredOn":"2026-09-28","progress":"\u642d\u597d\u73af\u5883","blocker":""}' > "$logbody"
log1=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/logs" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d @"$logbody")
code1=$(echo "$log1" | sed -E 's/.*"id":"([^"]+)".*/\1/')
log2=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/logs" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d @"$logbody")
code2=$(echo "$log2" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check "日志幂等重放同 id" "$code1" "$code2"
code=$(curl -s -b /tmp/dash-t2-cookies.txt -o /dev/null -w "%{http_code}" -X POST "$B/logs" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"clientEntryId":"draft-a","occurredOn":"2026-09-28","progress":"不同内容","blocker":""}')
check "同ID异正文 → 409" "$code" "409"

# 加成果
code=$(curl -s -b /tmp/dash-t2-cookies.txt -o /dev/null -w "%{http_code}" -X POST "$B/artifacts" -H "idempotency-key: t2-art" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d "{\"projectId\":\"$pid\",\"kind\":\"link\",\"title\":\"笔记\",\"body\":\"\",\"url\":\"https://example.com\"}")
check "添加链接成果 201" "$code" "201"

# today 快照包含任务与日志
today=$(curl -s -b /tmp/dash-t2-cookies.txt "$B/today")
check "today 含任务" "$(echo "$today" | grep -c "$tid")" "1"
check "today 含日志" "$(echo "$today" | grep -c '\"progress\"')" "1"

# 改期提案 → apply
prop=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/proposals" -H "idempotency-key: t2-prop1" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d "{\"type\":\"reschedule\",\"taskId\":\"$tid\",\"scheduledStart\":\"2026-10-02T19:00:00+08:00\",\"scheduledEnd\":null}")
prid=$(echo "$prop" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check "创建改期提案" "$([ -n "$prid" ] && echo yes)" "yes"
applied=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/proposals/$prid/apply" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{}')
check "apply 成功" "$(echo "$applied" | grep -c applied)" "1"
taskAfter=$(curl -s -b /tmp/dash-t2-cookies.txt "$B/tasks/$tid")
check "任务已改期" "$(echo "$taskAfter" | grep -c "2026-10-02T19:00:00")" "1"
ver=$(echo "$taskAfter" | sed -E 's/.*"version":([0-9]+).*/\1/')
again=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/proposals/$prid/apply" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{}')
ver2=$(echo "$again" | sed -E 's/.*"version":([0-9]+).*/\1/' | head -1)
taskAgain=$(curl -s -b /tmp/dash-t2-cookies.txt "$B/tasks/$tid")
ver3=$(echo "$taskAgain" | sed -E 's/.*"version":([0-9]+).*/\1/')
check "重复 apply 不重复写入" "$ver3" "$ver"

# 过时提案 409：直接改任务 → 再 apply 另一个提案
prop2=$(curl -s -b /tmp/dash-t2-cookies.txt -X POST "$B/proposals" -H "idempotency-key: t2-prop2" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d "{\"type\":\"reschedule\",\"taskId\":\"$tid\",\"scheduledStart\":\"2026-10-03T19:00:00+08:00\",\"scheduledEnd\":null}")
prid2=$(echo "$prop2" | sed -E 's/.*"id":"([^"]+)".*/\1/')
curl -s -b /tmp/dash-t2-cookies.txt -o /dev/null -X PATCH "$B/tasks/$tid" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d "{\"expectedVersion\":$ver3,\"title\":\"写实验（改）\"}"
code=$(curl -s -b /tmp/dash-t2-cookies.txt -o /dev/null -w "%{http_code}" -X POST "$B/proposals/$prid2/apply" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{}')
check "实体版本变化 → apply 409" "$code" "409"

echo "----"
echo "通过 $pass，失败 $fail"
exit "$fail"
