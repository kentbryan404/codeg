#!/usr/bin/env bash
#
# Codeg 根目录一键启动入口（开发模式）。
#
#   ./start.sh            # 桌面端开发（默认）→ src-tauri/start.sh
#   ./start.sh desktop    # 同上，参数透传（如 CODEG_SKIP_SIDECAR=0 ./start.sh）
#   ./start.sh server     # 服务器模式：前端 out/ + codeg-server → http://localhost:${CODEG_PORT:-3080}
#   ./start.sh web        # 仅前端 Next dev → http://localhost:3000
#   ./start.sh help
#
# 只做环境准备与分发，实际启动全部复用仓库既有入口。
#
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
}

need_pnpm() {
  command -v pnpm >/dev/null 2>&1 || {
    echo "[start][ERROR] 缺少依赖：pnpm 未安装或不在 PATH" >&2
    exit 1
  }
  if [ ! -d node_modules ]; then
    echo "[start] node_modules 不存在，执行 pnpm install"
    pnpm install --frozen-lockfile
  fi
}

target="${1:-desktop}"
[ $# -gt 0 ] && shift

case "$target" in
  desktop | app)
    need_pnpm
    exec ./src-tauri/start.sh "$@"
    ;;
  server)
    need_pnpm
    [ -d out ] || {
      echo "[start] out/ 不存在，先执行前端构建"
      pnpm build
    }
    export CODEG_STATIC_DIR="${CODEG_STATIC_DIR:-$PWD/out}"
    exec pnpm server:dev "$@"
    ;;
  web | frontend)
    need_pnpm
    exec pnpm dev "$@"
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    echo "[start][ERROR] 未知目标：$target" >&2
    usage
    exit 1
    ;;
esac
