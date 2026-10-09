#!/usr/bin/env bash
# 建立或恢复演示库（展示模式，docs/demo-mode.md）。用法: scripts/demo-seed.sh
# 只在 DEMO_MODE=1 下执行；全新的库先迁移再写入合成示例，已有的演示库恢复成初始示例。
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
npm run --silent demo:seed
