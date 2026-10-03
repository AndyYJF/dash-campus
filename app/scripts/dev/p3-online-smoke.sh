#!/usr/bin/env bash
# 线上 P3 冒烟：三端点结构 + 任务投递→重排→dashboard 出现学习块 → undo 清理。
set -uo pipefail
cd /opt/dash-campus
MOUNT="-v /opt/dash-campus/scripts/dev:/app/scripts/dev"
SESSION=$(docker compose --profile ops run --rm $MOUNT ops -c "node --import tsx /app/scripts/dev/make-online-session.ts" 2>/dev/null | tail -1)
TOKEN=$(echo "$SESSION" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
CSRF=$(echo "$SESSION" | grep -o '"csrf":"[^"]*"' | cut -d'"' -f4)
BASE="http://127.0.0.1:${DASH_PORT:-3020}"
AUTH=(-b "dash_session=$TOKEN" -H "content-type: application/json" -H "x-csrf-token: $CSRF")

echo "== dashboard =="
curl -s "${AUTH[@]}" "$BASE/api/v2/dashboard" | head -c 400; echo
echo "== week =="
curl -s "${AUTH[@]}" "$BASE/api/v2/week" | grep -o '"weekBudget":[0-9]*\|"snapshotRevision":"[^"]*"'
echo "== direction =="
curl -s "${AUTH[@]}" "$BASE/api/v2/direction" | grep -o '"evidenceState":"[^"]*"'

echo "== 投任务（2小时，明天截止）=="
cat > /tmp/p3-task.json <<'EOF'
{"text":"[smoke] 明天前要复习完操作系统第二章，大约需要两小时"}
EOF
CREATE=$(curl -s "${AUTH[@]}" -H "Idempotency-Key: smoke-p3-task-2" --data-binary @/tmp/p3-task.json "$BASE/api/v2/intakes")
ID=$(echo "$CREATE" | grep -o '"intakeId":"[^"]*"' | cut -d'"' -f4)
echo "intake: $ID"
sleep 12
docker compose --profile ops run --rm $MOUNT ops -c "node --import tsx -e \"
import { rebuildPlan } from '/app/src/workflows/plan';
const r = rebuildPlan(new Date());
console.log(JSON.stringify(r));
\"" 2>/dev/null | tail -1
echo "== dashboard sessions =="
curl -s "${AUTH[@]}" "$BASE/api/v2/dashboard" | grep -o '"sessions":\[[^]]*\]' | head -c 500; echo
echo "== 页面 HTML =="
for p in today week direction; do
  echo -n "/$p => "; curl -s -o /dev/null -w "%{http_code}" "${AUTH[@]}" "$BASE/$p"; echo
done
