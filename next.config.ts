import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"

const isProd = process.env.NODE_ENV === "production"
const internalHost = process.env.TAURI_DEV_HOST || "localhost"
// `before-build.mjs` 会置此变量，并另起一个 `pnpm typecheck` 与 Rust 编译并行跑
// （同一 tsconfig、同样会因失败中止构建），避免占据前端构建 ~60s 的串行时间。
// 直接 `pnpm build` / CI 不设此变量，仍在构建内做类型检查。
const parallelTypecheck = process.env.CODEG_PARALLEL_TSC === "1"
const withNextIntl = createNextIntlPlugin({
  requestConfig: "./src/i18n/request.ts",
  experimental: {
    messages: {
      path: "./src/i18n/messages",
      format: "json",
      locales: [
        "en",
        "zh-CN",
        "zh-TW",
        "ja",
        "ko",
        "es",
        "de",
        "fr",
        "pt",
        "ar",
      ],
      precompile: true,
    },
  },
})

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  assetPrefix: isProd ? undefined : `http://${internalHost}:3000`,
  experimental: {
    // 构建期也落盘 Turbopack 缓存：warm `next build` 复用上次编译结果，
    // 不再每次从零重编（本机实测基线约 166s）。
    turbopackFileSystemCacheForBuild: true,
  },
  reactCompiler: true,
  typescript: parallelTypecheck ? { ignoreBuildErrors: true } : undefined,
}

export default withNextIntl(nextConfig)
