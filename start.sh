#!/usr/bin/env bash
# AGNET 一行指令部署：自动准备 .env（随机令牌）并拉起完整栈（WebUI + 知识库）
set -euo pipefail
cd "$(dirname "$0")"

# 1. 缺少 .env 时，复制模板并把占位令牌替换为随机值
if [ ! -f .env ]; then
  cp .env.example .env
  TOKEN=$(openssl rand -hex 24)
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|^LLM_WIKI_API_TOKEN=.*|LLM_WIKI_API_TOKEN=$TOKEN|" .env
  else
    sed -i "s|^LLM_WIKI_API_TOKEN=.*|LLM_WIKI_API_TOKEN=$TOKEN|" .env
  fi
  echo "[ok] 已生成 .env（含随机 LLM_WIKI_API_TOKEN）"
fi

# 2. 把 .env 载入当前 shell，便于打印正确端口
set -a
# shellcheck disable=SC1091
. ./.env 2>/dev/null || true
set +a

echo "==> 拉起完整栈（含知识库；首次会自动构建镜像，含 Rust 编译，可能耗时数分钟）"
docker compose --profile kb up -d

PORT="${PORT:-6060}"
WIKI_PORT="${WIKI_PORT:-19828}"
echo
echo "部署完成："
echo "  Hermes Studio : http://localhost:$PORT"
echo "  知识库 API    : http://localhost:$WIKI_PORT/api/v1"
echo "查看日志      : docker compose --profile kb logs -f"
echo "停止服务      : docker compose --profile kb down"
