#!/usr/bin/env bash
# 浏览器界面检查：独立库 + 独立端口 3217，fixture 模型，不调用真实服务、不发邮件。
# 需要本机 Edge（EDGE_PATH 可覆盖）。截图与结果写入 data/ui-check/。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

export SETUP_TOKEN="ui-check-token"
export DATABASE_PATH="./data/ui-check.db"
export MODEL_PROTOCOL="fake"
export SEARCH_PROVIDER=""
rm -f data/ui-check.db data/ui-check.db-wal data/ui-check.db-shm
rm -rf data/ui-check
bash scripts/migrate.sh > /dev/null
[ "${UI_SKIP_BUILD:-}" = "1" ] || npm run build > /tmp/dash-ui-build.log 2>&1

source scripts/smoke-lib.sh
SMOKE_PORT=3217
npx next start -p 3217 > /tmp/dash-ui-web.log 2>&1 &
smoke_track $!
B="http://localhost:3217/api/v1"
for _ in $(seq 1 30); do curl -s -o /dev/null "$B/health" && break; sleep 1; done

# 示例数据：一个项目、几条任务（含长标题与长 URL）、一条记录、可用时间（node 发送，保证 UTF-8）
UI_BASE="http://localhost:3217" npx tsx scripts/ui-seed.mts
UI_BASE="http://localhost:3217" npx tsx scripts/ui-check.mts
