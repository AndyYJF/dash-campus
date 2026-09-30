#!/usr/bin/env bash
# T3 HTTP 冒烟：提醒 job 生命周期（创建→通知→取消）、邮件预览不发送、未配置 SMTP 的 test 503
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-t3-token"
export DATABASE_PATH="./data/smoke-t3.db"
rm -f data/smoke-t3.db data/smoke-t3.db-wal data/smoke-t3.db-shm
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
SMOKE_PORT=3212
npx next start -p 3212 > /tmp/dash-t3-smoke.log 2>&1 &
smoke_track $!
# 同库 worker（一个实例一个 worker；本趟无到期 job，验证可启动与可停止）
npx tsx src/worker/index.ts > /tmp/dash-t3-worker.log 2>&1 &
smoke_track $!
sleep 4

B="http://localhost:3212/api/v1"
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}

curl -s -o /dev/null -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-t3-token","password":"smoke-pass-123"}'
login=$(curl -s -c /tmp/dash-t3-cookies.txt -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
csrf=$(echo "$login" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')

# 未登录不可读（F20 局部）
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/notifications")
check "未登录 GET /notifications → 401" "$code" "401"

# 建任务：instant due +25h → 提醒触发点 +1h（未来）
due=$(node -e "console.log(new Date(Date.now()+25*3600000).toISOString())")
taskbody=$(mktemp)
printf '%s' "{\"title\":\"T3 smoke\",\"estimateMinutes\":30,\"due\":{\"kind\":\"instant\",\"at\":\"$due\",\"timezone\":\"UTC\"}}" > "$taskbody"
task=$(curl -s -b /tmp/dash-t3-cookies.txt -X POST "$B/tasks" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -H 'idempotency-key: t3-task-1' -d @"$taskbody")
tid=$(echo "$task" | sed -E 's/.*"id":"([^"]+)".*/\1/')
check "创建带截止的任务" "$([ -n "$tid" ] && echo yes)" "yes"

# notifications 显示未来提醒
notifs=$(curl -s -b /tmp/dash-t3-cookies.txt "$B/notifications")
check "notifications 含未来提醒" "$(echo "$notifs" | grep -c 'upcomingReminders')" "1"
upcount=$(echo "$notifs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.upcomingReminders.length)})")
check "未来提醒恰好 1 条" "$upcount" "1"
jid=$(echo "$notifs" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.upcomingReminders[0].jobId)})")

# 取消提醒 job
cancel=$(curl -s -b /tmp/dash-t3-cookies.txt -X POST "$B/jobs/$jid/cancel" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{}')
check "取消 queued 提醒" "$(echo "$cancel" | grep -c '"result":"cancelled"')" "1"
job=$(curl -s -b /tmp/dash-t3-cookies.txt "$B/jobs/$jid")
check "job 状态 cancelled" "$(echo "$job" | grep -c '"status":"cancelled"')" "1"

# 邮件预览：不产生发送
preview=$(curl -s -b /tmp/dash-t3-cookies.txt -X POST "$B/mail/preview" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{}')
check "预览返回主题（subject/html/纯文本）" "$(echo "$preview" | grep -o '截止提醒' | wc -l | tr -d ' ')" "3"
check "预览为合成示例" "$(echo "$preview" | grep -c '"sample":true')" "1"

# 测试邮件：SMTP 未配置 → 503 INTEGRATION_UNAVAILABLE
code=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/dash-t3-cookies.txt -X POST "$B/mail/test" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{}')
check "未配置 SMTP → 503" "$code" "503"

# deliveries 为空（未配置不创建投递）
deliveries=$(curl -s -b /tmp/dash-t3-cookies.txt "$B/deliveries")
count=$(echo "$deliveries" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.deliveries.length)})")
check "投递记录为空" "$count" "0"

# settings 读取与乐观锁
settings=$(curl -s -b /tmp/dash-t3-cookies.txt "$B/settings")
ver=$(echo "$settings" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.version)})")
setbody=$(mktemp)
printf '%s' '{"expectedVersion":0,"privacyMode":true}' > "$setbody"
saved=$(curl -s -b /tmp/dash-t3-cookies.txt -X PATCH "$B/settings" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d @"$setbody")
check "首次保存模板设置（隐私模式）" "$(echo "$saved" | grep -c '"privacyMode":true')" "1"
code=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/dash-t3-cookies.txt -X PATCH "$B/settings" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d @"$setbody")
check "重复 expectedVersion → 409" "$code" "409"

# worker 正常运行标记
check "worker 启动日志存在" "$(grep -c '启动，轮询间隔' /tmp/dash-t3-worker.log)" "1"

echo "----"
echo "通过 $pass，失败 $fail"
exit "$fail"
