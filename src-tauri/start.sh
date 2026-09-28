#!/usr/bin/env bash
#
# Codeg 桌面端一键构建并启动
#
#   1. 前端静态导出 out/（缺失、或前端源码比 out/ 新时重导；dev 窗口走 devUrl）
#   2. pnpm tauri dev  —— cargo 增量编译 Rust 并启动桌面窗口
#
# 「代码有更新就重编，确保启动的是最新代码」：
#   * Rust 主程序由 cargo 增量编译、dev 前端由 Next dev 热更新，天然是最新；
#   * out/ 静态导出与 codeg-mcp sidecar 不会自动跟着源文件变，这里按 mtime 判定：
#     源文件比产物新才重编，未变就跳过（省时间）。
#   * 强制选项：CODEG_FORCE_FRONTEND=1 重导 out/；CODEG_SKIP_SIDECAR=0 / 1
#     强制 / 禁止 sidecar 重编。
#
set -euo pipefail
cd "$(dirname "$0")"

# 与打包入口共用加速器（mold/lld + sccache），让 `tauri dev` 每次重链也走快链接器。
. ./scripts/cargo-accelerators.sh

# ---------------------------------------------------------------------------
# 前端静态导出 out/：DEV 模式下**只有缺失时才导出**。
#
# 为什么 dev 不看 mtime：`tauri.conf.json` 的 `devUrl` 指向 Next dev 服务器，
# dev 窗口根本不吃 out/。而重写 out/ 会改 tauri-build 追踪的 frontendDist →
# 把巨型 codeg crate 判脏、整个重编（几分钟）。所以"前端源码更新就重导"在 dev
# 里是纯亏：既白跑一次 next build，又把主 crate 弄脏。要最新的静态产物就
# CODEG_FORCE_FRONTEND=1，或走 `pnpm tauri build`（beforeBuildCommand 会导）。
# ---------------------------------------------------------------------------
if [ "${CODEG_FORCE_FRONTEND:-0}" = "1" ] || [ ! -f ../out/index.html ]; then
  echo "[start] 导出静态资源 out/（显式强制或产物缺失）"
  pnpm build
else
  echo "[start] dev 复用已有 out/（devUrl 提供前端；强制重导：CODEG_FORCE_FRONTEND=1）"
fi

# ---------------------------------------------------------------------------
# codeg-mcp sidecar：会被复制到 target/debug/codeg-mcp 并随代理会话启动。
# 仅当相关 Rust 源码有更新（或产物缺失/仍是 0 字节占位符）时，才让
# beforeDevCommand 里的 prepare-sidecars 真正编译；否则跳过。
#
# DEV 用 **debug** profile（CODEG_SIDECAR_PROFILE=debug）：release 编译整个
# codeg lib 每次要几分钟，而 dev 下 sidecar 只是一次性的本机 MCP 进程，
# debug 版完全够用，且与主 dev 构建共享 target/debug 的依赖产物。发布/CI
# 不经过本脚本，仍是 release。
# ---------------------------------------------------------------------------
export CODEG_SIDECAR_PROFILE=debug
needs_sidecar=0
case "${CODEG_SKIP_SIDECAR:-auto}" in
  1)
    echo "[start] 跳过 sidecar 重编（显式 CODEG_SKIP_SIDECAR=1）"
    ;;
  0)
    echo "[start] 重编 sidecar（显式 CODEG_SKIP_SIDECAR=0）"
    needs_sidecar=1
    ;;
  *)
    # triple 与 prepare-sidecars.mjs 同源：rustc 的 host triple。
    host_triple="$(rustc -vV 2>/dev/null | sed -n 's/^host: //p' || true)"
    sidecar_bin="binaries/codeg-mcp-${host_triple}"
    case "$host_triple" in *windows*) sidecar_bin="${sidecar_bin}.exe" ;; esac
    if [ -z "$host_triple" ] || [ ! -s "$sidecar_bin" ]; then
      needs_sidecar=1
    elif [ -n "$(find src experts science resources ../src/browser-injected \
      Cargo.toml Cargo.lock build.rs \
      -type f -newer "$sidecar_bin" -print -quit 2>/dev/null)" ]; then
      needs_sidecar=1
    fi
    if [ "$needs_sidecar" = "1" ]; then
      echo "[start] codeg-mcp 源码有更新（或产物缺失）→ 重编 sidecar（release，较慢）"
    else
      echo "[start] codeg-mcp 源码未变，跳过 sidecar 重编（强制：CODEG_SKIP_SIDECAR=0）"
    fi
    ;;
esac
if [ "$needs_sidecar" = "1" ]; then
  export CODEG_SKIP_SIDECAR=0
else
  export CODEG_SKIP_SIDECAR=1
fi

exec pnpm tauri dev
