#!/usr/bin/env bash
# T5 HTTP 冒烟（fixture：MODEL_PROTOCOL=fake / SEARCH_PROVIDER=fake，不调用真实服务）：
# 未登录 401 → 缺幂等键 422 → 探索 202 → worker 执行 → 候选（未知条件）→ 未接受未知 422 →
# 带未知开始建独立项目 → 重复 200 exists → 结论 → 关注方向开关 → 立即运行
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="smoke-t5-token"
export DATABASE_PATH="./data/smoke-t5.db"
export MODEL_PROTOCOL="fake"
export SEARCH_PROVIDER="fake"
rm -f data/smoke-t5.db data/smoke-t5.db-wal data/smoke-t5.db-shm
bash scripts/migrate.sh > /dev/null

source scripts/smoke-lib.sh
SMOKE_PORT=3214
npx next start -p 3214 > /tmp/dash-t5-smoke.log 2>&1 &
smoke_track $!
npx tsx src/worker/index.ts > /tmp/dash-t5-worker.log 2>&1 &
smoke_track $!
sleep 5

B="http://localhost:3214/api/v1"
C=/tmp/dash-t5-cookies.txt
pass=0; fail=0
check() {
  if [ "$2" = "$3" ]; then pass=$((pass+1)); echo "✔ $1"
  else fail=$((fail+1)); echo "✖ $1 实际=$2 期望=$3"; fi
}
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const v=($1);console.log(typeof v==='object'?JSON.stringify(v):v)})"; }

code=$(curl -s -o /dev/null -w "%{http_code}" "$B/explorations")
check "未登录 GET /explorations → 401" "$code" "401"

curl -s -o /dev/null -X POST "$B/setup" -H 'content-type: application/json' -d '{"token":"smoke-t5-token","password":"smoke-pass-123"}'
login=$(curl -s -c "$C" -X POST "$B/auth/login" -H 'content-type: application/json' -d '{"password":"smoke-pass-123"}')
csrf=$(echo "$login" | sed -E 's/.*"csrfToken":"([^"]+)".*/\1/')
H=(-b "$C" -H 'content-type: application/json' -H "x-csrf-token: $csrf")

check "集成状态显示已配置（fixture）" "$(curl -s "$B/integrations" | jget 'j.integrations.model.state+","+j.integrations.search.state')" "configured,configured"

q=$(mktemp); printf '%s' '{"query":"我想了解机器学习入门实践"}' > "$q"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/explorations" -d @"$q")
check "缺 Idempotency-Key → 422" "$code" "422"

resp=$(curl -s -w "\n%{http_code}" "${H[@]}" -H "idempotency-key: t5-k1" -X POST "$B/explorations" -d @"$q")
check "发起探索 → 202" "$(echo "$resp" | tail -1)" "202"
run=$(echo "$resp" | head -1 | jget 'j.runId')
check "fixture 模式单独标识" "$(echo "$resp" | head -1 | jget 'j.integrationMode')" "fixture"
replay=$(curl -s "${H[@]}" -H "idempotency-key: t5-k1" -X POST "$B/explorations" -d @"$q" | jget 'j.runId')
check "同键重放返回同一 run" "$replay" "$run"

status=""
for _ in $(seq 1 30); do
  status=$(curl -s -b "$C" "$B/explorations/$run" | jget 'j.run.status')
  [ "$status" = "done" ] || [ "$status" = "failed" ] && break
  sleep 1
done
check "worker 执行完成" "$status" "done"
det=$(curl -s -b "$C" "$B/explorations/$run")
n=$(echo "$det" | jget 'j.candidates.length')
check "1–3 个候选" "$([ "$n" -ge 1 ] && [ "$n" -le 3 ] && echo ok || echo "$n")" "ok"
check "候选条件无 met（未确认）" "$(echo "$det" | jget 'j.candidates.flatMap(c=>c.requirements).some(r=>r.status==="met")')" "false"
check "证据为已取回原文" "$(echo "$det" | jget 'j.evidence.every(e=>e.status==="retrieved")')" "true"

cid=$(echo "$det" | jget 'j.candidates[0].id')
cver=$(echo "$det" | jget 'j.candidates[0].version')
body=$(mktemp)
printf '%s' "{\"expectedVersion\":$cver,\"title\":\"我的实践\",\"question\":\"想验证\",\"expectedOutcome\":\"一页记录\",\"startInclination\":\"interested\",\"tasks\":[{\"title\":\"第一步\"}]}" > "$body"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/candidates/$cid/create-project" -d @"$body")
check "未接受未知条件 → 422" "$code" "422"

printf '%s' "{\"expectedVersion\":$cver,\"title\":\"我的实践\",\"question\":\"想验证\",\"expectedOutcome\":\"一页记录\",\"startInclination\":\"interested\",\"acceptUnknowns\":true,\"tasks\":[{\"title\":\"第一步\"},{\"title\":\"第二步\",\"estimateMinutes\":60}]}" > "$body"
cr=$(curl -s -w "\n%{http_code}" "${H[@]}" -X POST "$B/candidates/$cid/create-project" -d @"$body")
check "带未知条件开始 → 201" "$(echo "$cr" | tail -1)" "201"
pid=$(echo "$cr" | head -1 | jget 'j.projectId')
check "建了 2 个任务" "$(curl -s -b "$C" "$B/tasks?projectId=$pid" | jget 'j.tasks.length')" "2"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X POST "$B/candidates/$cid/create-project" -d @"$body")
check "重复创建 → 200 exists" "$code" "200"

check "未填结论" "$(curl -s -b "$C" "$B/projects/$pid/conclusion" | jget 'j.exploration.conclusion')" "null"
pver=$(curl -s -b "$C" "$B/projects/$pid" | jget 'j.project.version')
concl=$(mktemp); printf '%s' "{\"expectedVersion\":$pver,\"experiencedActivities\":\"跑了一遍\",\"conclusion\":\"continue\",\"reason\":\"有意思\"}" > "$concl"
check "保存本人结论" "$(curl -s "${H[@]}" -X POST "$B/projects/$pid/conclusion" -d @"$concl" | jget 'j.exploration.conclusion')" "continue"

tp=$(mktemp); printf '%s' '{"title":"信息检索","purpose":"入门实践","enabled":false}' > "$tp"
tid=$(curl -s "${H[@]}" -H "idempotency-key: t5-topic" -X POST "$B/exploration-topics" -d @"$tp" | jget 'j.id')
en=$(curl -s "${H[@]}" -X PATCH "$B/exploration-topics/$tid" -d '{"expectedVersion":1,"enabled":true,"weekday":3,"localTime":"20:30"}')
check "开启定期 → next_run_at 已计算" "$(echo "$en" | jget 'Boolean(j.topic.nextRunAt)&&j.topic.enabled')" "true"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X PATCH "$B/exploration-topics/$tid" -d '{"expectedVersion":1,"enabled":false}')
check "旧版本停用 → 409" "$code" "409"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -H "idempotency-key: t5-run" -X POST "$B/exploration-topics/$tid/run")
check "立即运行一次 → 202" "$code" "202"

tpl=$(curl -s -b "$C" "$B/practice-templates")
check "3 个模板均为 draft" "$(echo "$tpl" | jget 'j.templates.length+":"+j.templates.every(t=>t.status==="draft")')" "3:true"
code=$(curl -s -o /dev/null -w "%{http_code}" "${H[@]}" -X PATCH "$B/practice-templates/tpl-text-retrieval" -d '{"expectedVersion":1,"status":"ready"}')
check "无来源许可不能标 ready → 422" "$code" "422"

code=$(curl -s -o /dev/null -w "%{http_code}" -b "$C" "http://localhost:3214/explore")
check "/explore 页面 200" "$code" "200"
code=$(curl -s -o /dev/null -w "%{http_code}" -b "$C" "http://localhost:3214/explore/$run")
check "/explore/[id] 页面 200" "$code" "200"

echo "----"
echo "通过 $pass，失败 $fail"
exit "$fail"
