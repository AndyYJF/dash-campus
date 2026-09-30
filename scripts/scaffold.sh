#!/usr/bin/env bash
# T0 脚手架：创建 Next.js + TypeScript 项目（一次性脚本）
set -euo pipefail

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
echo "项目根目录: $ROOT"

if [ -d app ]; then
  echo "app 目录已存在，跳过脚手架"
  exit 0
fi

# create-next-app 需要在空目录或新目录名上运行，先把项目建在临时子目录再合并
npx --yes create-next-app@latest app \
  --typescript \
  --eslint \
  --no-tailwind \
  --app \
  --src-dir \
  --import-alias "@/*" \
  --use-npm

echo "脚手架完成: $ROOT/app"
