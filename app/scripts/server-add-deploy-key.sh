#!/usr/bin/env bash
# 在生产服务器上以 root 执行一次：加入部署公钥（只追加，不覆盖已有 key；重复执行不会重复添加）
# 用法：DEPLOY_PUBKEY='ssh-ed25519 AAAA... comment' bash scripts/server-add-deploy-key.sh
# 不要把真实公钥写进这个文件或提交到仓库。
set -euo pipefail
KEY="${DEPLOY_PUBKEY:-}"
if [ -z "$KEY" ]; then
  echo "请设置 DEPLOY_PUBKEY 为部署公钥整行" >&2
  exit 1
fi
mkdir -p ~/.ssh
chmod 700 ~/.ssh
touch ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
if grep -qF "$KEY" ~/.ssh/authorized_keys; then
  echo "部署公钥已存在，无需重复添加"
else
  printf '%s\n' "$KEY" >> ~/.ssh/authorized_keys
  echo "已加入部署公钥"
fi
