#!/usr/bin/env bash
#
# 本地 cargo 编译加速器，供桌面端 dev / build 入口（以及仓库根 build.sh）共用。
# 以 source 方式载入（不是执行），导出落在调用方环境里，随后的 cargo / tauri dev
# 子进程自动继承。
#
#   * 链接器：优先 mold（大二进制链接通常快于 lld），其次 lld。RUSTFLAGS 已带
#     `-fuse-ld` 或设了 CODEG_NO_LLD=1 则跳过。
#   * sccache 作为 RUSTC_WRAPPER 做跨次编译缓存；已设 RUSTC_WRAPPER 或
#     CODEG_NO_SCCACHE=1 则跳过。
#
# 幂等：重复 source 无副作用，调用方已导出的值不会被覆盖。
# 用 bash 的 `[[ ]]`：只有它才对 `!= *"fuse-ld"*` 做 glob 匹配；`[ ]` 的 `!=`
# 是纯字符串比较，判不出已设的 `-fuse-ld`，重复 source 会重复追加。
if [[ -z "${CODEG_NO_LLD:-}" && "${RUSTFLAGS:-}" != *"fuse-ld"* ]]; then
  if command -v mold >/dev/null 2>&1; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=mold"
    echo "[cargo] 启用 mold 链接器"
  elif command -v ld.lld >/dev/null 2>&1 || command -v lld >/dev/null 2>&1; then
    export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-fuse-ld=lld"
    echo "[cargo] 启用 lld 链接器"
  fi
fi

if [ -z "${CODEG_NO_SCCACHE:-}" ] && [ -z "${RUSTC_WRAPPER:-}" ] &&
  command -v sccache >/dev/null 2>&1; then
  export RUSTC_WRAPPER=sccache
  echo "[cargo] 启用 sccache 编译缓存"
fi
