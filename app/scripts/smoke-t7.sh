#!/usr/bin/env bash
# T7 冒烟（本地、fixture，不调用真实服务）：
# 导出 401/202/下载/删除后 404；schema 不匹配时 web 拒绝启动；
# 停机检查 → backup → restore（hold）→ hold 期间外部入口 503、worker 不领取 → resume → 只重建未来提醒
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-t7-token"
export DATABASE_PATH="./data/smoke-t7/dash-campus.db"
export MODEL_PROTOCOL="fake"
export SEARCH_PROVIDER=""
export APP_BASE_URL="http://localhost:3216"
BK="./data/smoke-t7-backups"
rm -rf ./data/smoke-t7 "$BK"
mkdir -p ./data/smoke-t7 "$BK"
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
EXPECTED_SCHEMA=$(sed -n 's/^export const EXPECTED_SCHEMA_VERSION = \([0-9]*\);$/\1/p' src/repositories/db.ts)
SMOKE_PORT=3216
B="http://localhost:3216/api/v1"
C=/tmp/dash-t7-cookies.txt
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)})"; }
start_web() {
  npx next start -p 3216 > /tmp/dash-t7-web.log 2>&1 &
  WEB_PID=$!
  smoke_track $WEB_PID
  for _ in $(seq 1 30); do curl -s -o /dev/null "$B/health" && return 0; sleep 1; done
  return 1
}
stop_web() {
  smoke_kill "$WEB_PID"
  for _ in $(seq 1 20); do curl -s -o /dev/null "$B/health" || return 0; sleep 1; done
}
login() {
  local r; r=$(curl -s -c "$C" -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
  csrf=$(echo "$r" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
  H=(-b "$C" -H 'content-type: application/json' -H "x-csrf-token: $csrf")
}

start_web
code=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$B/exports" -H 'content-type: application/json' -H 'idempotency-key: x' -d '{"type":"full_json"}')
check "未登录 POST /exports → 401" "$code" "401"
curl -s -o /dev/null -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-t7-token","password":"smoke-pass-123"}'
login

# 1. 导出
r=$(curl -s -w "\n%{http_code}" "${H[@]}" -H "idempotency-key: t7-ex1" -X POST "$B/exports" -d '{"type":"full_json"}')
check "导出 full_json → 202" "$(echo "$r" | tail -1)" "202"
EX=$(echo "$r" | head -1 | jget "j.export.id")
check "导出状态 ready" "$(echo "$r" | head -1 | jget "j.export.status")" "ready"
code=$(curl -s -o /dev/null -w "%{http_code}" "$B/exports/$EX/download")
check "未登录下载 → 401" "$code" "401"
body=$(curl -s -b "$C" "$B/exports/$EX/download")
check "下载内容是 full_json" "$(echo "$body" | jget "j.format")" "dash-campus.full_json"
check "full_json 不含 sessions" "$(echo "$body" | jget "String(j.tables.sessions===undefined)")" "true"
check "full_json 不含密码摘要" "$(echo "$body" | grep -c password_hash || true)" "0"

PR=$(curl -s "${H[@]}" -H "idempotency-key: t7-p" -X POST "$B/projects" -d '{"title":"T7 项目","question":"q","expectedOutcome":"","prerequisites":"","reviewQuestions":""}'); P=$(echo "$PR" | jget "j.id")
curl -s -o /dev/null "${H[@]}" -X POST "$B/logs" -d "{\"clientEntryId\":\"7a7a7a7a-0000-4000-8000-000000000001\",\"occurredOn\":\"2026-09-20\",\"progress\":\"picked-progress\",\"blocker\":\"\",\"taskId\":null,\"projectId\":\"$P\"}"
curl -s -o /dev/null "${H[@]}" -X POST "$B/logs" -d "{\"clientEntryId\":\"7a7a7a7a-0000-4000-8000-000000000002\",\"occurredOn\":\"2026-09-21\",\"progress\":\"unpicked-progress\",\"blocker\":\"\",\"taskId\":null,\"projectId\":\"$P\"}"
L1=$(curl -s -b "$C" "$B/logs?projectId=$P" | jget "j.logs.find(l=>l.progress==='picked-progress').id")
pv=$(curl -s "${H[@]}" -X POST "$B/exports/report-preview" -d "{\"projectId\":\"$P\",\"fields\":[\"actions\",\"nextSteps\"],\"selectedLogIds\":[\"$L1\"]}")
check "报告预览只含选中记录" "$(echo "$pv" | jget "String(j.markdown.includes('picked-progress') && !j.markdown.includes('unpicked-progress'))")" "true"
check "缺失字段留空" "$(echo "$pv" | jget "j.missing.join(',')")" "nextSteps"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X DELETE "$B/exports/$EX")
check "删除导出 → 200" "$code" "200"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$C" "$B/exports/$EX/download")
check "删除后下载 → 404" "$code" "404"

# 2. 备份前的业务状态：一条未来提醒
due=$(node -e "console.log(new Date(Date.now()+72*3600e3).toISOString())")
T=$(curl -s "${H[@]}" -H "idempotency-key: t7-t" -X POST "$B/tasks" -d "{\"title\":\"remind-after-restore\",\"due\":{\"kind\":\"instant\",\"at\":\"$due\",\"timezone\":\"UTC\"}}" | jget "j.id")

# 3. 服务运行时备份被拒绝
set +e
out=$(bash scripts/backup.sh "$BK" 2>&1); rc=$?
set -e
check "web 运行中备份被拒绝" "$rc" "1"
check "拒绝原因可读" "$(echo "$out" | grep -c 'web 仍在响应')" "1"

stop_web
out=$(bash scripts/backup.sh "$BK" 2>&1)
check "停机后备份成功" "$(echo "$out" | grep -c '备份完成')" "1"
BDIR=$(ls -d "$BK"/dash-campus-backup-* | head -1)
check "备份清单记录 schemaVersion" "$(jget "j.schemaVersion" < "$BDIR/manifest.json")" "$EXPECTED_SCHEMA"

# 4. schema 不匹配：web 拒绝启动并说明
node -e "const D=require('better-sqlite3');const d=new D('$DATABASE_PATH');d.prepare('UPDATE schema_version SET version=$((EXPECTED_SCHEMA - 1))').run();d.close()"
set +e
timeout 60 npx next start -p 3216 > /tmp/dash-t7-web-bad.log 2>&1; rc=$?
set -e
check "schema 过旧时 web 退出" "$([ $rc -ne 0 ] && echo yes || echo no)" "yes"
check "退出说明提示迁移" "$(grep -c 'scripts/migrate.sh' /tmp/dash-t7-web-bad.log)" "1"
node -e "const D=require('better-sqlite3');const d=new D('$DATABASE_PATH');d.prepare('UPDATE schema_version SET version=$EXPECTED_SCHEMA').run();d.close()"

# 5. 恢复：hold 状态
set +e
out=$(bash scripts/restore.sh ./data/nope 2>&1); rc=$?
set -e
check "无效备份目录 → 失败且可读" "$rc/$(echo "$out" | grep -c '恢复失败')" "1/1"
out=$(bash scripts/restore.sh "$BDIR" 2>&1)
check "restore 完成并进入暂停" "$(echo "$out" | grep -c '已进入恢复暂停')" "1"
check "原库改名保留" "$(ls ./data/smoke-t7 | grep -c "dash-campus.db.pre-restore-[0-9-]*$")" "1"

start_web
login
st=$(curl -s -b "$C" "$B/instance")
check "GET /instance hold=true" "$(echo "$st" | jget "j.hold")" "true"
check "旧提醒 job 已挂起" "$(echo "$st" | jget "String(j.heldJobs.some(x=>x.taskId==='$T'))")" "true"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -H "idempotency-key: t7-rv" -X POST "$B/reviews/generate" -d '{}')
check "hold 期间生成复盘 → 503" "$code" "503"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/mail/test" -d '{}')
check "hold 期间测试邮件 → 503" "$code" "503"
npx tsx src/worker/index.ts > /tmp/dash-t7-worker.log 2>&1 &
WK=$!; smoke_track $WK
sleep 8
check "hold 期间 worker 不领取" "$(grep -c '恢复暂停' /tmp/dash-t7-worker.log)" "1"
smoke_kill "$WK"
sleep 1

# 6. resume：非交互需显式确认
set +e
out=$(bash scripts/resume-after-restore.sh < /dev/null 2>&1); rc=$?
set -e
check "未确认不解除" "$rc/$(echo "$out" | grep -c '需要确认')" "1/1"
# worker 心跳 20 秒内视为仍在运行（与 backup/restore 同一判据）；这里 resume 不查心跳，直接确认
out=$(bash scripts/resume-after-restore.sh --yes-old-instance-stopped 2>&1)
check "确认后解除暂停" "$(echo "$out" | grep -c '已解除恢复暂停')" "1"
st=$(curl -s -b "$C" "$B/instance")
check "GET /instance hold=false" "$(echo "$st" | jget "j.hold")" "false"
n=$(curl -s -b "$C" "$B/notifications" | jget "j.upcomingReminders.filter(r=>r.taskId==='$T').length")
check "未来提醒按当前任务重建 1 条" "$n" "1"

stop_web
echo "== T7: 通过 $pass，失败 $fail"
rm -rf ./data/smoke-t7 "$BK"
[ "$fail" -eq 0 ]
