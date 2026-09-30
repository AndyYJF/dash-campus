#!/usr/bin/env bash
# T4 HTTP 冒烟：来源创建 → 导入（F1/F3 路径）→ 纠正身份 → 建任务 → r2 不覆盖（F5）→ 仅本条（F4）
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-t4-token"
export DATABASE_PATH="./data/smoke-t4.db"
rm -f data/smoke-t4.db data/smoke-t4.db-wal data/smoke-t4.db-shm
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
SMOKE_PORT=3213
npx next start -p 3213 > /tmp/dash-t4-smoke.log 2>&1 &
smoke_track $!
sleep 4

B="http://localhost:3213/api/v1"
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}

curl -s -o /dev/null -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-t4-token","password":"smoke-pass-123"}'
login=$(curl -s -c /tmp/dash-t4-cookies.txt -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
csrf=$(echo "$login" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')

# 创建来源 → token（仅出现一次）
srccode=$(curl -s -b /tmp/dash-t4-cookies.txt -o /tmp/dash-t4-src.json -w "%{http_code}" -X POST "$B/inbox/sources" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"id":"weixin-group","title":"班级群"}')
check "创建来源 201" "$srccode" "201"
TOKEN=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{console.log(JSON.parse(s).token)})" < /tmp/dash-t4-src.json)

code=$(curl -s -o /dev/null -w "%{http_code}" "$B/inbox")
check "未登录 GET /inbox → 401" "$code" "401"

# 导入 F1（暂无身份事实 → UNKNOWN/review）
body1=$(mktemp)
printf '%s' '{"schemaVersion":1,"source":"weixin-group","externalId":"n1","revisionKey":"r1","revisionOrder":1,"occurredAt":"2026-09-28T10:00:00Z","text":"面向所有本科一年级学生，需提交表单。","structured":{"noticeType":"campus_event","condition":{"kind":"leaf","field":"education_level","op":"eq","value":"本科一年级","quote":"面向所有本科一年级学生"},"action":{"actionKey":"a1","title":"提交表单","description":"","required":true}}}' > "$body1"
imp=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @"$body1")
check "导入 → created" "$(echo "$imp" | grep -c '"kind":"created"')" "1"
mid=$(echo "$imp" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.messageId)})")
det=$(curl -s -b /tmp/dash-t4-cookies.txt "$B/inbox/$mid")
check "无身份事实 → UNKNOWN" "$(echo "$det" | grep -c '"applicability":"UNKNOWN"')" "1"
check "分区 review（不猜资格）" "$(echo "$det" | grep -o '\"partition\":\"[a-z]*\"' | head -1 | tr -d '\r')" '"partition":"review"'

# 更正身份（scope=profile）→ 重评 → action
prof=$(mktemp)
printf '%s' '{"scope":"profile","facts":[{"field":"education_level","value":"本科一年级","expectedVersion":0}]}' > "$prof"
res=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/$mid/resolve" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d @"$prof")
check "更正身份" "$(echo "$res" | grep -c '"resolved":"profile"')" "1"
det=$(curl -s -b /tmp/dash-t4-cookies.txt "$B/inbox/$mid")
check "身份符合 → action" "$(echo "$det" | grep -o '\"partition\":\"[a-z]*\"' | head -1 | tr -d '\r')" '"partition":"action"'

# 建任务 → 再建不重复
create=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/$mid/create-task" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"actionKey":"a1"}')
check "创建任务" "$(echo "$create" | grep -c '"kind":"created"')" "1"
tid=$(echo "$create" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.taskId)})")
rid=$(echo "$imp" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.revisionId)})")
again=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/$mid/create-task" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"actionKey":"a1"}')
check "重复创建 → exists 同一任务" "$(echo "$again" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.kind==='exists'&&j.taskId==='$tid'?'ok':'bad')})")" "ok"

# 主人改任务标题（r2 之前），携带 sourceRevisionId
patch=$(mktemp)
printf '%s' "{\"expectedVersion\":1,\"title\":\"我自己的表单\",\"sourceRevisionId\":\"$rid\"}" > "$patch"
curl -s -o /dev/null -b /tmp/dash-t4-cookies.txt -X PATCH "$B/tasks/$tid" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d @"$patch"

# F5：r2 到达（来源改标题）→ 不覆盖
body2=$(mktemp)
printf '%s' '{"schemaVersion":1,"source":"weixin-group","externalId":"n1","revisionKey":"r2","revisionOrder":2,"occurredAt":"2026-09-28T12:00:00Z","text":"面向所有本科一年级学生，需提交表单（更新）。","structured":{"noticeType":"campus_event","condition":{"kind":"leaf","field":"education_level","op":"eq","value":"本科一年级","quote":"面向所有本科一年级学生"},"action":{"actionKey":"a1","title":"提交表单（来源新标题）","description":"","required":true}}}' > "$body2"
imp2=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @"$body2")
check "r2 成为当前" "$(echo "$imp2" | grep -c '"becameCurrent":true')" "1"
task=$(curl -s -b /tmp/dash-t4-cookies.txt "$B/tasks/$tid")
check "任务标题不被来源覆盖" "$(echo "$task" | grep -c '我自己的表单')" "1"
check "sourceRevisionId 已记录" "$(echo "$task" | grep -c "\"sourceRevisionId\":\"$rid\"")" "1"
imp3=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @"$body1")
check "r1 重放" "$(echo "$imp3" | grep -c '"kind":"replay"')" "1"
check "r1 重放后 current 不回退" "$(curl -s -b /tmp/dash-t4-cookies.txt "$B/inbox/$mid" | grep -c '"isCurrent":true')" "1"

# F4：仅本条纠正 → folded；同类新通知不受影响
vol=$(mktemp)
printf '%s' '{"schemaVersion":1,"source":"weixin-group","externalId":"vol-1","revisionKey":"r1","revisionOrder":1,"occurredAt":"2026-09-28T13:00:00Z","text":"自愿活动，自愿参加。","structured":{"noticeType":"voluntary_event","condition":{"kind":"leaf","field":"education_level","op":"eq","value":"本科一年级","quote":"自愿参加"},"action":{"actionKey":"v1","title":"自愿活动","description":"","required":false}}}' > "$vol"
volimp=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @"$vol")
vmid=$(echo "$volimp" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.messageId)})")
only=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/$vmid/resolve" -H 'content-type: application/json' -H "x-csrf-token: $csrf" -d '{"scope":"this_revision","partition":"folded"}')
check "仅本条覆盖" "$(echo "$only" | grep -c '"resolved":"this_revision"')" "1"
vol2=$(mktemp)
printf '%s' '{"schemaVersion":1,"source":"weixin-group","externalId":"vol-2","revisionKey":"r1","revisionOrder":1,"occurredAt":"2026-09-28T14:00:00Z","text":"自愿活动2，自愿参加。","structured":{"noticeType":"voluntary_event","condition":{"kind":"leaf","field":"education_level","op":"eq","value":"本科一年级","quote":"自愿参加"},"action":{"actionKey":"v1","title":"自愿活动2","description":"","required":false}}}' > "$vol2"
volimp2=$(curl -s -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @"$vol2")
v2mid=$(echo "$volimp2" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.messageId)})")
v2det=$(curl -s -b /tmp/dash-t4-cookies.txt "$B/inbox/$v2mid")
check "新通知仍为 opportunity（F4）" "$(echo "$v2det" | grep -c '"partition":"opportunity"')" "1"

# 错 token → 403；同 key 异正文 → 409
code=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer bad-token" -H 'content-type: application/json' -d @"$body1")
check "错 token → 403" "$code" "403"
tamper=$(mktemp)
printf '%s' '{"schemaVersion":1,"source":"weixin-group","externalId":"n1","revisionKey":"r1","revisionOrder":1,"occurredAt":"2026-09-28T10:00:00Z","text":"被篡改的正文。"}' > "$tamper"
code=$(curl -s -o /dev/null -w "%{http_code}" -b /tmp/dash-t4-cookies.txt -X POST "$B/inbox/import" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @"$tamper")
check "同 key 异正文 → 409" "$code" "409"

echo "----"
echo "通过 $pass，失败 $fail"
exit "$fail"

