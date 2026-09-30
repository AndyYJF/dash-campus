#!/usr/bin/env bash
# T6 HTTP 冒烟（fixture 模型，不调用真实服务）：
# 无记录复盘 → 资料不足；写带卡点的记录 → 分析卡点 202 → worker → 提案 → 应用 → 计划更新；
# 拒绝后同依据不重复；主人修订复盘；预算 429
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-t6-token"
export DATABASE_PATH="./data/smoke-t6.db"
export MODEL_PROTOCOL="fake"
export SEARCH_PROVIDER=""
rm -f data/smoke-t6.db data/smoke-t6.db-wal data/smoke-t6.db-shm
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
SMOKE_PORT=3215
npx next start -p 3215 > /tmp/dash-t6-smoke.log 2>&1 &
smoke_track $!
npx tsx src/worker/index.ts > /tmp/dash-t6-worker.log 2>&1 &
smoke_track $!
sleep 5

B="http://localhost:3215/api/v1"
C=/tmp/dash-t6-cookies.txt
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)})"; }
waitfor() { # url expr-for-status
  local st=""
  for _ in $(seq 1 30); do
    st=$(curl -s -b "$C" "$1" | jget "$2")
    case "$st" in queued|generating|running) sleep 1 ;; *) break ;; esac
  done
  echo "$st"
}

code=$(curl -s -o /dev/null -w "%{http_code}" "$B/reviews")
check "未登录 GET /reviews → 401" "$code" "401"

curl -s -o /dev/null -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-t6-token","password":"smoke-pass-123"}'
login=$(curl -s -c "$C" -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
csrf=$(echo "$login" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
H=(-b "$C" -H 'content-type: application/json' -H "x-csrf-token: $csrf")

# 1. 空周复盘 → 资料不足
r=$(curl -s -w "\n%{http_code}" "${H[@]}" -H "idempotency-key: t6-rv0" -X POST "$B/reviews/generate" -d '{"localMonday":"2025-01-06"}')
check "生成复盘 → 202" "$(echo "$r" | tail -1)" "202"
rid0=$(echo "$r" | head -1 | jget 'j.reviewId')
check "无记录 → 资料不足" "$(waitfor "$B/reviews/$rid0" 'j.review.status')" "insufficient"

# 2. 项目 + 任务 + 带卡点的记录
pid=$(curl -s "${H[@]}" -H "idempotency-key: t6-p" -X POST "$B/projects" -d '{"title":"检索实践"}' | jget 'j.id')
tb=$(mktemp); printf '%s' "{\"title\":\"实现 BM25\",\"projectId\":\"$pid\",\"estimateMinutes\":60}" > "$tb"
tid=$(curl -s "${H[@]}" -H "idempotency-key: t6-t" -X POST "$B/tasks" -d @"$tb" | jget 'j.id')
today=$(node -e "console.log(new Date(Date.now()+8*3600e3).toISOString().slice(0,10))")
lb=$(mktemp); printf '%s' "{\"clientEntryId\":\"$(node -e 'console.log(crypto.randomUUID())')\",\"occurredOn\":\"$today\",\"progress\":\"读了论文\",\"blocker\":\"不知道怎么切分中文\",\"taskId\":\"$tid\",\"projectId\":\"$pid\"}" > "$lb"
lid=$(curl -s "${H[@]}" -X POST "$B/logs" -d @"$lb" | jget 'j.log.id')

# 3. 分析卡点 → 提案 → 应用
ab=$(mktemp); printf '%s' "{\"scopeType\":\"project\",\"scopeId\":\"$pid\",\"logId\":\"$lid\"}" > "$ab"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/assistant/requests" -d @"$ab")
check "分析缺幂等键 → 422" "$code" "422"
a=$(curl -s -w "\n%{http_code}" "${H[@]}" -H "idempotency-key: t6-a1" -X POST "$B/assistant/requests" -d @"$ab")
check "分析卡点 → 202" "$(echo "$a" | tail -1)" "202"
aid=$(echo "$a" | head -1 | jget 'j.requestId')
check "分析完成" "$(waitfor "$B/assistant/requests/$aid" 'j.request.status')" "done"
ad=$(curl -s -b "$C" "$B/assistant/requests/$aid")
check "读取范围含所选记录" "$(echo "$ad" | jget "j.request.result.readScope.logIds.includes('$lid')")" "true"
check "最多 1 份提案" "$(echo "$ad" | jget 'j.proposals.length')" "1"
prop=$(echo "$ad" | jget 'j.proposals[0].id')
check "提案依据引用该记录" "$(echo "$ad" | jget "j.proposals[0].contextRefs.includes('$lid')")" "true"
before=$(curl -s -b "$C" "$B/tasks?projectId=$pid" | jget 'j.tasks.length')
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/proposals/$prop/apply" -d '{}')
check "应用提案 → 200" "$code" "200"
after=$(curl -s -b "$C" "$B/tasks?projectId=$pid" | jget 'j.tasks.length')
check "计划已更新（多 1 个任务）" "$after" "$((before+1))"

# 4. 拒绝 → 同依据不重复；重跑可以
a2=$(curl -s "${H[@]}" -H "idempotency-key: t6-a2" -X POST "$B/assistant/requests" -d @"$ab" | jget 'j.requestId')
waitfor "$B/assistant/requests/$a2" 'j.request.status' > /dev/null
p2=$(curl -s -b "$C" "$B/assistant/requests/$a2" | jget 'j.proposals[0] && j.proposals[0].id')
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/proposals/$p2/reject" -d '{"reason":"not_useful"}')
check "拒绝提案 → 200" "$code" "200"
a3=$(curl -s "${H[@]}" -H "idempotency-key: t6-a3" -X POST "$B/assistant/requests" -d @"$ab" | jget 'j.requestId')
waitfor "$B/assistant/requests/$a3" 'j.request.status' > /dev/null
check "冷却期内不重复" "$(curl -s -b "$C" "$B/assistant/requests/$a3" | jget 'j.proposals.length')" "0"

# 5. 本周复盘 + 主人修订
monday=$(node -e "const d=new Date(Date.now()+8*3600e3);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));console.log(d.toISOString().slice(0,10))")
rid=$(curl -s "${H[@]}" -H "idempotency-key: t6-rv1" -X POST "$B/reviews/generate" -d "{\"localMonday\":\"$monday\"}" | jget 'j.reviewId')
check "本周复盘已生成" "$(waitfor "$B/reviews/$rid" 'j.review.status')" "ready"
rv=$(curl -s -b "$C" "$B/reviews/$rid")
check "事实含该记录" "$(echo "$rv" | jget "j.review.facts.logs.some(l=>l.id==='$lid')")" "true"
check "AI 部分标为示例" "$(echo "$rv" | jget 'j.review.integrationMode')" "fixture"
ver=$(echo "$rv" | jget 'j.review.version')
ob=$(mktemp); printf '%s' "{\"expectedVersion\":$ver,\"ownerSummary\":\"这周主要卡在分词\"}" > "$ob"
check "主人修订" "$(curl -s "${H[@]}" -X PATCH "$B/reviews/$rid" -d @"$ob" | jget 'j.review.ownerSummary')" "这周主要卡在分词"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X PATCH "$B/reviews/$rid" -d @"$ob")
check "旧版本修订 → 409" "$code" "409"

# 6. 预算：上限设为 0 → 429
bv=$(curl -s -b "$C" "$B/ai-budget" | jget 'j.version')
curl -s -o /dev/null "${H[@]}" -X PATCH "$B/ai-budget" -d "{\"expectedVersion\":$bv,\"dailyModelCalls\":0}"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -H "idempotency-key: t6-a4" -X POST "$B/assistant/requests" -d @"$ab")
check "超预算 → 429" "$code" "429"
check "用量已记录" "$(curl -s -b "$C" "$B/ai-budget" | jget 'j.usage.modelCalls>0')" "true"

for p in reviews "reviews/$rid" settings; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -b "$C" "http://localhost:3215/$p")
  check "/$p 页面 200" "$code" "200"
done

echo "----"
echo "通过 $pass，失败 $fail"
exit "$fail"
