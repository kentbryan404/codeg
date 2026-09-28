#!/usr/bin/env bash
#
# Codeg 根目录一键构建入口。
#
#   ./build.sh                  # 桌面安装包（默认）→ src-tauri/build.sh
#   ./build.sh desktop --fast   # 透传参数给 src-tauri/build.sh（--fast/--bundles ...）
#   ./build.sh frontend         # 前端静态导出 → out/ → pnpm build
#   ./build.sh help
#
# 这里只做分发与依赖校验，各目标的实际构建全部复用仓库既有入口，不重复实现。
#
set -euo pipefail
cd "$(dirname "$0")"

# 本机 cargo 编译加速（mold/lld + sccache）：与 src-tauri 的 dev/build 入口共用同一份。
. src-tauri/scripts/cargo-accelerators.sh

usage() {
  sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'
}

need() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "[build][ERROR] 缺少依赖：$1 未安装或不在 PATH" >&2
    exit 1
  }
}

target="${1:-desktop}"
[ $# -gt 0 ] && shift

case "$target" in
  desktop | app)
    need pnpm
    exec ./src-tauri/build.sh "$@"
    ;;
  frontend | web)
    need pnpm
    exec pnpm build "$@"
    ;;
  help | -h | --help)
    usage
    ;;
  *)
    echo "[build][ERROR] 未知目标：$target" >&2
    usage
    exit 1
    ;;
esac
