#!/usr/bin/env bash
#
# Codeg 桌面端一键构建并启动
#
#   1. 前端静态导出 out/（仅当缺失时；dev 窗口走 devUrl）
#   2. pnpm tauri dev  —— 编译 Rust 并启动桌面窗口
#
# 默认跳过 codeg-mcp sidecar 的 release 编译（最慢的一步，源码未变时无需重编）。
# 需要重编 sidecar 时：CODEG_SKIP_SIDECAR=0 ./start.sh
# 需要重刷前端静态导出时：CODEG_FORCE_FRONTEND=1 ./start.sh
#
set -euo pipefail
cd "$(dirname "$0")"

# 与打包入口共用加速器（mold/lld + sccache），让 `tauri dev` 每次重链也走快链接器。
. ./scripts/cargo-accelerators.sh

export CODEG_SKIP_SIDECAR="${CODEG_SKIP_SIDECAR:-1}"

# 只在 out/ 缺失时做静态导出。dev 的窗口加载 devUrl（Next dev server），
# out/ 只供编译期 `generate_context!` 与内嵌 Web 服务使用；而重写 out/ 会改
# tauri-build 追踪的 frontendDist → 把巨型 codeg crate 判脏重编（几分钟）。
# 复用已有 out/ 即可让纯 Rust 迭代保持 Fresh。
if [ "${CODEG_FORCE_FRONTEND:-0}" = "1" ] || [ ! -f ../out/index.html ]; then
  pnpm build
else
  echo "[start] 复用已有 out/（不重导，避免重编 codeg；重刷：CODEG_FORCE_FRONTEND=1）"
fi
exec pnpm tauri dev
