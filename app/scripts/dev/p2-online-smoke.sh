#!/usr/bin/env bash
# 线上 P2 冒烟（在 VPS 上执行）：临时会话 → 投混合材料 → 回答首周 → 验证课程落模型+投影。
# 中文一律走文件（Windows/SSH argv 会转码）；不影响既有数据，测试课程名带 [smoke] 前缀便于识别。
set -uo pipefail
cd /opt/dash-campus

SESSION=$(docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/scripts-dev ops -c "node --import tsx /scripts-dev/make-online-session.ts" 2>/dev/null | tail -1)
TOKEN=$(echo "$SESSION" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
CSRF=$(echo "$SESSION" | grep -o '"csrf":"[^"]*"' | cut -d'"' -f4)
[ -z "$TOKEN" ] && { echo "会话创建失败: $SESSION"; exit 1; }
BASE="http://127.0.0.1:${DASH_PORT:-3020}"

cat > /tmp/smoke-create.json <<'EOF'
{"text":"SDCT1\nT=20\nP=1,08:15-09:00;2,09:10-09:55\nC=[smoke]线性代数|李老师|B202|3|1-2|1-16|A|-\n[smoke] 今天复习了30分钟线代"}
EOF

CREATE=$(curl -s -b "dash_session=$TOKEN" -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
  -H "Idempotency-Key: smoke-p2-online-1" --data-binary @/tmp/smoke-create.json "$BASE/api/v2/intakes")
echo "create: $CREATE"
ID=$(echo "$CREATE" | grep -o '"intakeId":"[^"]*"' | cut -d'"' -f4)
[ -z "$ID" ] && exit 1

for i in $(seq 1 30); do
  RESP=$(curl -s -b "dash_session=$TOKEN" "$BASE/api/v2/intakes/$ID")
  ST=$(echo "$RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" != "received" ] && [ "$ST" != "processing" ] && break
  sleep 2
done
QID=$(echo "$RESP" | grep -o '"questions":\[{"id":"[^"]*"' | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
QVER=$(echo "$RESP" | grep -o '"version":[0-9]*' | tail -1 | cut -d: -f2)
echo "after first pass: status=$ST question=$QID v$QVER"
[ -z "$QID" ] && { echo "$RESP" | head -c 600; exit 1; }

printf '{"text":"第5周","expectedVersion":%s}' "$QVER" > /tmp/smoke-answer.json
curl -s -b "dash_session=$TOKEN" -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
  -H "Idempotency-Key: smoke-p2-online-2" --data-binary @/tmp/smoke-answer.json \
  "$BASE/api/v2/questions/$QID/answers"; echo

for i in $(seq 1 30); do
  RESP=$(curl -s -b "dash_session=$TOKEN" "$BASE/api/v2/intakes/$ID")
  ST=$(echo "$RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  [ "$ST" != "received" ] && [ "$ST" != "processing" ] && break
  sleep 2
done
echo "final status: $ST"
docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/scripts-dev ops -c "node --import tsx /scripts-dev/p2-online-verify.ts" 2>/dev/null | tail -6
