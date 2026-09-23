#!/usr/bin/env bash
#
# Codeg 桌面端一键构建并启动
#
#   1. pnpm build      —— 生成静态导出 out/（tauri.conf.json 的 bundle.resources 依赖它）
#   2. pnpm tauri dev  —— 编译 Rust 并启动桌面窗口
#
# 默认跳过 codeg-mcp sidecar 的 release 编译（最慢的一步，源码未变时无需重编）。
# 需要重编 sidecar 时：CODEG_SKIP_SIDECAR=0 ./start.sh
#
set -euo pipefail
cd "$(dirname "$0")"

export CODEG_SKIP_SIDECAR="${CODEG_SKIP_SIDECAR:-1}"

pnpm build
exec pnpm tauri dev
