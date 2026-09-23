#!/usr/bin/env bash
#
# Codeg 桌面端一键打包
#
#   ./build.sh                  # 按当前平台打出原生安装包
#   ./build.sh --fast           # 本地迭代：关 LTO / 放开 codegen-units，编译快、产物性能略降
#   ./build.sh --bundles all    # 覆盖默认，打全部产物
#   ./build.sh --debug          # debug 构建（快，产物不用于分发）
#   ./build.sh -- --help        # 其余参数原样透传给 `tauri build`
#
# 本脚本只做编排与前置校验，实际构建全部复用仓库既有入口，不重复实现：
#   `pnpm tauri build`
#     └─ beforeBuildCommand = `pnpm tauri:before-build`
#          └─ node src-tauri/scripts/before-build.mjs
#               ├─ pnpm build                 前端静态导出 → out/（bundle.resources 依赖）
#               └─ pnpm tauri:prepare-sidecars  codeg-mcp sidecar 的 release 编译
#            两步互不依赖，并发执行；任一步失败即中止（设 CODEG_SERIAL_BEFORE_BUILD=1 可改回串行）。
#       然后 cargo 编译桌面端并按 --bundles 打包。
# Linux 上完成后，把生成的 .deb 另复制一份到仓库根目录（见脚本末尾）。
#
# 本地构建加速（都不改分发流程的语义）：
#   * 链接器优先 mold、其次 lld。任一缺装即跳过；设 CODEG_NO_LLD=1 可整体关闭。
#   * 装了 sccache 就自动挂上做跨次编译缓存（RUSTC_WRAPPER）；设
#     CODEG_NO_SCCACHE=1 关闭。
#   * 本仓库没有 [profile.release]，cargo 默认即 opt-level=3 / lto=false /
#     codegen-units=16。因此 `--fast` 的旧实现（关 LTO + codegen-units=16）改的
#     全是默认值、等于空操作。现在 `--fast` 走真正更快的档位（见下）；普通构建
#     的产物语义不变。
#
# 两个本地构建的坑，脚本已代处理：
#   1. tauri.conf.json 的 bundle.createUpdaterArtifacts=true 在缺少
#      TAURI_SIGNING_PRIVATE_KEY 时会直接构建失败；本脚本在未设置该密钥时
#      通过 --config 关闭 updater 产物，使本地未签名构建可通过。
#   2. targets="all" 在 Linux 上会连 rpm/appimage 一起打，缺 rpmbuild 时失败；
#      脚本默认只打当前平台的原生产物，需要全量再显式 --bundles all。
#
# 交叉编译（--target）不在本脚本职责内：那需要先按目标 triple 单独准备
# sidecar（见 CI release.yml），host 一键构建不需要。
#
set -euo pipefail
cd "$(dirname "$0")"

for bin in node pnpm cargo rustc; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "[build][ERROR] 缺少依赖：$bin 未安装或不在 PATH" >&2
    exit 1
  }
done

# 链接器与编译缓存加速：只影响本机这次构建，不改产物语义。
# 链接器优先 mold（大二进制链接通常快于 lld），其次 lld；有 sccache 则挂上。
# 任一未安装即自动跳过。
if [ -z "${CODEG_NO_LLD:-}" ] && [ "${RUSTFLAGS:-}" != *"fuse-ld"* ]; then
  if command -v mold >/dev/null 2>&1; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=mold"
    echo "[build] 启用 mold 链接器"
  elif command -v ld.lld >/dev/null 2>&1 || command -v lld >/dev/null 2>&1; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=lld"
    echo "[build] 启用 lld 链接器"
  fi
fi

if [ -z "${CODEG_NO_SCCACHE:-}" ] && [ -z "${RUSTC_WRAPPER:-}" ] &&
  command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache
  echo "[build] 启用 sccache 编译缓存"
fi

if [ ! -d node_modules ]; then
  echo "[build] node_modules 不存在，执行 pnpm install"
  pnpm install --frozen-lockfile
fi

# 用户未显式指定 --bundles 时，按当前平台选一个能直接跑通的原生产物。
# `--fast` 是本脚本自己的开关，吞掉、不透传给 tauri。
USER_ARGS=("$@")
has_bundles=false
has_config=false
fast=false
for a in "${USER_ARGS[@]}"; do
  case "$a" in
    --fast) fast=true ;;
    --bundles | --bundles=*) has_bundles=true ;;
    --config | --config=*) has_config=true ;;
  esac
done

if $fast; then
  passthrough=()
  for a in "${USER_ARGS[@]}"; do
    [ "$a" = "--fast" ] || passthrough+=("$a")
  done
  USER_ARGS=("${passthrough[@]+"${passthrough[@]}"}")
  # 用环境变量覆盖 cargo 的 release 档位，不动 Cargo.toml（本仓库没有 [profile.release]）。
  # opt-level 降到 1、codegen-units 拉到 256、开增量、去掉调试信息：这是本地迭代档，
  # 明显缩短编译，代价是运行性能；不要拿它出分发包。
  export CARGO_PROFILE_RELEASE_OPT_LEVEL=1
  export CARGO_PROFILE_RELEASE_LTO=false
  export CARGO_PROFILE_RELEASE_CODEGEN_UNITS=256
  export CARGO_PROFILE_RELEASE_DEBUG=0
  export CARGO_PROFILE_RELEASE_INCREMENTAL=true
  echo "[build] --fast：opt-level=1、codegen-units=256、incremental、无调试信息"
fi

ARGS=(build)
if ! $has_bundles; then
  case "$(uname -s)" in
    Darwin) ARGS+=(--bundles dmg) ;;
    Linux) ARGS+=(--bundles deb) ;;
    MINGW* | MSYS* | CYGWIN*) ARGS+=(--bundles nsis) ;;
    *) echo "[build] 未知平台，交给 tauri 默认 bundler" ;;
  esac
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && ! $has_config; then
  echo "[build] 未设置 TAURI_SIGNING_PRIVATE_KEY，关闭 updater 签名产物（本地未签名构建）"
  ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
fi

echo "[build] pnpm tauri ${ARGS[*]} ${USER_ARGS[*]:-}"
pnpm tauri "${ARGS[@]}" ${USER_ARGS[@]+"${USER_ARGS[@]}"}

echo
echo "[build] 完成，产物位于 src-tauri/target/release/bundle（脚本此处 cwd 已是 src-tauri）："
ls -1 target/release/bundle 2>/dev/null || true

# deb 另复制一份到仓库根目录 dist/，方便直接取用（tauri 固定输出到 target/.../bundle）。
# 注意：本脚本开头已 cd 到 src-tauri，故路径相对 src-tauri，而非相对仓库根。
shopt -s nullglob
debs=(target/release/bundle/deb/*.deb)
if [ "${#debs[@]}" -eq 0 ]; then
  echo "[build] 未找到 deb 产物（非 Linux 平台，或 --bundles 未包含 deb）"
else
  mkdir -p ../dist
  for d in "${debs[@]}"; do
    cp -f "$d" "../dist/$(basename "$d")"
    echo "[build] deb 已放到根目录：./dist/$(basename "$d")"
  done
fi
