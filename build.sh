#!/usr/bin/env bash
#
# Codeg 根目录一键构建入口。
#
#   ./build.sh                  # 桌面安装包（默认）→ src-tauri/build.sh
#   ./build.sh desktop --fast   # 透传参数给 src-tauri/build.sh（--fast/--bundles ...）
#   ./build.sh server           # 服务器二进制 codeg-server → pnpm server:build
#   ./build.sh frontend         # 前端静态导出 → out/ → pnpm build
#   ./build.sh docker           # Docker 镜像 codeg:local → docker build
#   ./build.sh help
#
# 这里只做分发与依赖校验，各目标的实际构建全部复用仓库既有入口，不重复实现。
#
set -euo pipefail
cd "$(dirname "$0")"

# 本机 cargo 编译加速：链接器优先 mold、其次 lld，装了 sccache 就挂上跨次缓存。
# 在此统一导出，让 server / sidecar 等所有 cargo 目标都受益；desktop 目标下
# src-tauri/build.sh 会检测到已设置而不再重复添加。任一工具缺失即自动跳过。
if [ -z "${CODEG_NO_LLD:-}" ] && [ "${RUSTFLAGS:-}" != *"fuse-ld"* ]; then
  if command -v mold >/dev/null 2>&1; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=mold"
  elif command -v ld.lld >/dev/null 2>&1 || command -v lld >/dev/null 2>&1; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=lld"
  fi
fi
if [ -z "${CODEG_NO_SCCACHE:-}" ] && [ -z "${RUSTC_WRAPPER:-}" ] &&
  command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache
fi

usage() {
  sed -n '3,15p' "$0" | sed 's/^# \{0,1\}//'
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
  server)
    need pnpm
    exec pnpm server:build "$@"
    ;;
  frontend | web)
    need pnpm
    exec pnpm build "$@"
    ;;
  docker)
    need docker
    exec docker build -t codeg:local "$@" .
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
