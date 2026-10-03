#!/usr/bin/env bash
# 线上 P4 冒烟（在 VPS 上执行）：临时会话 → multipart 上传 ICS → 验证 fixed_events 落库 → undo 清理。
# ICS 内容全 ASCII，走文件传递避免 argv 转码。
set -uo pipefail
cd /opt/dash-campus

SESSION=$(docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/app/scripts/dev ops -c "node --import tsx /app/scripts/dev/make-online-session.ts" 2>/dev/null | tail -1)
TOKEN=$(echo "$SESSION" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
CSRF=$(echo "$SESSION" | grep -o '"csrf":"[^"]*"' | cut -d'"' -f4)
[ -z "$TOKEN" ] && { echo "会话创建失败: $SESSION"; exit 1; }
BASE="http://127.0.0.1:${DASH_PORT:-3020}"

cat > /tmp/smoke-p4.ics <<'EOF'
BEGIN:VCALENDAR
BEGIN:VEVENT
UID:smoke-p4-1@dash
DTSTART:20261009T140000
DTEND:20261009T153000
SUMMARY:[smoke] ICS 讲座
END:VEVENT
END:VCALENDAR
EOF

# multipart 上传（curl -F 自带 boundary）
RESP=$(curl -sS --noproxy '*' -X POST "$BASE/api/v2/intakes" \
  -H "Cookie: dash_session=$TOKEN" -H "x-csrf-token: $CSRF" \
  -H "Idempotency-Key: smoke-p4-ics-$(date +%s)" \
  -F "files=@/tmp/smoke-p4.ics;type=text/calendar")
echo "create: $RESP"
IID=$(echo "$RESP" | grep -o '"intakeId":"[^"]*"' | cut -d'"' -f4)
[ -z "$IID" ] && { echo "上传失败"; exit 1; }

# 轮询处理完成
for i in $(seq 1 10); do
  sleep 2
  STATUS=$(curl -sS --noproxy '*' "$BASE/api/v2/intakes/$IID" -H "Cookie: dash_session=$TOKEN")
  STATE=$(echo "$STATUS" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
  echo "poll $i: $STATE"
  case "$STATE" in completed|partially_applied|failed|cancelled) break;; esac
done
echo "$STATUS" | head -c 600; echo

# 验证 fixed_events 落库（ops 容器内查 DB）
docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/app/scripts/dev ops \
  -c "node --import tsx /app/scripts/dev/p4-online-verify.ts" 2>/dev/null | tail -5
