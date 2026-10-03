#!/usr/bin/env bash
# P1 端到端证据：真实 next dev + worker + 已配置真实模型，走 混合投递→提问→回答→恢复 全链路。
# 使用独立 V2 开发库 data/v2/dash-campus.db；不触碰生产与旧开发库。
set -euo pipefail
cd "$(dirname "$0")/../.."

# 清理上次可能残留的 dev server/worker（Windows 上 npx 子进程不受 bash kill 控制）
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='node_repl.exe'\" | Where-Object { \$_.CommandLine -match 'dash-campus|next dev|worker/index' } | ForEach-Object { Stop-Process -Id \$_.ProcessId -Force }" 2>/dev/null || true
sleep 1

export DATABASE_PATH=./data/v2/dash-campus.db
export NO_PROXY='*' no_proxy='*'   # 本机有代理环境变量，回环地址不能走代理
PORT=3210
BASE="http://127.0.0.1:$PORT"
JAR=$(mktemp)
trap 'rm -f "$JAR"; taskkill //F //T //PID $WEB_PID //PID $WORKER_PID >/dev/null 2>&1 || true' EXIT

echo "== 启动 web($PORT) 与 worker =="
npx next dev -p $PORT >/tmp/v2-web.log 2>&1 &
WEB_PID=$!
npm run worker >/tmp/v2-worker.log 2>&1 &
WORKER_PID=$!

for i in $(seq 1 60); do
  if curl -sf --noproxy '*' "$BASE/api/v1/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
echo "health: $(curl -s --noproxy '*' "$BASE/api/v1/health")"

SETUP_TOKEN=$(grep '^SETUP_TOKEN=' .env | cut -d= -f2-)
echo "== 初始化 owner 并登录 =="
SETUP_RESP=$(curl -s --noproxy '*' -c "$JAR" -H 'content-type: application/json' \
  -d "{\"token\":\"$SETUP_TOKEN\",\"password\":\"v2dev-password-123\"}" "$BASE/api/v1/setup")
echo "$SETUP_RESP" | head -c 200; echo
LOGIN_RESP=$(curl -s --noproxy '*' -c "$JAR" -b "$JAR" -H 'content-type: application/json' \
  -d '{"password":"v2dev-password-123"}' "$BASE/api/v1/auth/login")
CSRF=$(echo "$LOGIN_RESP" | grep -o '"csrfToken":"[^"]*"' | cut -d'"' -f4)
if [ -z "$CSRF" ]; then echo "登录失败: $LOGIN_RESP"; exit 1; fi
echo "登录成功"

echo "== 投递混合材料（SDCT1 课表 + 实践记录）=="
PAYLOAD_DIR=$(mktemp -d)
node scripts/dev/make-e2e-payloads.mjs "$PAYLOAD_DIR"
CREATE=$(curl -s --noproxy '*' -b "$JAR" -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
  -H "Idempotency-Key: e2e-p1-mixed-1" --data-binary "@$PAYLOAD_DIR/create.json" \
  "$BASE/api/v2/intakes")
echo "$CREATE"
INTAKE_ID=$(echo "$CREATE" | grep -o '"intakeId":"[^"]*"' | cut -d'"' -f4)

poll() { # $1=intake id, 等到非 received/processing
  for i in $(seq 1 45); do
    RESP=$(curl -s --noproxy '*' -b "$JAR" "$BASE/api/v2/intakes/$1")
    STATUS=$(echo "$RESP" | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
    if [ "$STATUS" != "received" ] && [ "$STATUS" != "processing" ]; then echo "$RESP"; return; fi
    sleep 2
  done
  echo "$RESP"
}

echo "== 等待首次处理（真实模型分类）=="
R1=$(poll "$INTAKE_ID")
echo "$R1" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify({status:r.intake.status,items:r.items.map(i=>({kind:i.kind,state:i.state,summary:i.summary,error:i.error})),questions:r.questions.map(q=>({key:q.questionKey,status:q.status}))},null,1))'

QID=$(echo "$R1" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(r.questions.find(q=>q.status==="open")?.id??"")')
QVER=$(echo "$R1" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(r.questions.find(q=>q.status==="open")?.version??"")')
if [ -z "$QID" ]; then echo "没有 open 问题，流程异常"; exit 1; fi

echo "== 回答「第5周」=="
node scripts/dev/make-e2e-payloads.mjs "$PAYLOAD_DIR" "$QVER"
curl -s --noproxy '*' -b "$JAR" -H "content-type: application/json" -H "x-csrf-token: $CSRF" \
  -H "Idempotency-Key: e2e-p1-answer-1" \
  --data-binary "@$PAYLOAD_DIR/answer.json" "$BASE/api/v2/questions/$QID/answers"; echo
rm -rf "$PAYLOAD_DIR"

echo "== 等待恢复完成 =="
R2=$(poll "$INTAKE_ID")
echo "$R2" | node -e 'const r=JSON.parse(require("fs").readFileSync(0));console.log(JSON.stringify({status:r.intake.status,items:r.items.map(i=>({kind:i.kind,state:i.state,candidate:i.candidate?{firstMonday:i.candidate.firstMonday,courseCount:i.candidate.courseCount,occurrenceCount:i.candidate.occurrenceCount}:null}))},null,1))'
