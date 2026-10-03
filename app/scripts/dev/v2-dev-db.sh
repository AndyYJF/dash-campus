#!/usr/bin/env bash
# P0：建立独立 V2 开发库（data/v2/dash-campus.db），从零跑全量迁移并核对版本/epoch。
# 不触碰既有 data/dash-campus.db（旧开发库）与任何生产数据。
set -euo pipefail
cd "$(dirname "$0")/../.."

V2_DB="data/v2/dash-campus.db"
if [ -e "$V2_DB" ]; then
  echo "已存在 $V2_DB，不重建；删除后重跑可重建"
else
  mkdir -p data/v2
  DATABASE_PATH="./$V2_DB" npm run migrate
fi

node -e "
const D = require('better-sqlite3');
const db = new D('$V2_DB'); // 不用 readonly：WAL 库首次读取需建 -shm/-wal，readonly 会报 SQLITE_CANTOPEN
console.log('schema_version:', db.prepare('SELECT version FROM schema_version WHERE id=1').get());
console.log('instance_state:', db.prepare('SELECT restored_hold, deployment_epoch FROM instance_state WHERE id=1').get());
const tables = db.prepare(\"SELECT count(*) c FROM sqlite_master WHERE type='table'\").get();
console.log('tables:', tables.c);
"
