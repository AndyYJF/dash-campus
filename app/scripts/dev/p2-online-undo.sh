#!/usr/bin/env bash
# 线上 undo 冒烟 + 清理：撤销本次 smoke 产生的全部 batch（应全部 200；之后 smoke 数据消失）。
set -uo pipefail
cd /opt/dash-campus
SESSION=$(docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/scripts-dev ops -c "node --import tsx /scripts-dev/make-online-session.ts" 2>/dev/null | tail -1)
TOKEN=$(echo "$SESSION" | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
CSRF=$(echo "$SESSION" | grep -o '"csrf":"[^"]*"' | cut -d'"' -f4)
IDS=$(docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/scripts-dev ops -c "node --import tsx /scripts-dev/list-batch-ids.ts" 2>/dev/null | tail -1)
echo "batches: $IDS"
for B in $IDS; do
  echo -n "undo $B => "
  curl -s -b "dash_session=$TOKEN" -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
    -H "Idempotency-Key: smoke-undo-$B" -d '{"expectedVersion":1}' "http://127.0.0.1:3020/api/v2/actions/$B/undo"
  echo
done
docker compose --profile ops run --rm -v /opt/dash-campus/scripts/dev:/scripts-dev ops -c "node --import tsx /scripts-dev/p2-online-verify.ts" 2>/dev/null | tail -6
