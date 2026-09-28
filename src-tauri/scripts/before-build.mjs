#!/usr/bin/env node
//
// Pre-build hook for `tauri build` (desktop bundling).
//
// Tauri runs `beforeBuildCommand` to completion before it ever starts the main
// cargo build, so everything it needs must be ready when this exits:
//   * `pnpm build`                  — Next static export → out/ (bundle.resources)
//   * `pnpm tauri:prepare-sidecars` — codeg-mcp release sidecar → binaries/
//   * `pnpm typecheck`              — started after the frontend, run in parallel
//                                     with the sidecar compile (the frontend
//                                     skips its own copy via CODEG_PARALLEL_TSC)
//
// The first two run back to back, frontend first: on a host build the sidecar
// compiles codeg_lib with the Tauri runtime on (see prepare-sidecars.mjs), so
// its `tauri::generate_context!()` reads `../out` at compile time and must not
// race the frontend export. Every step must succeed — a failure in any fails
// this hook, so Tauri never starts against a partial out/ or a missing sidecar.
//
// Node-only on purpose: runs identically on macOS, Linux and Windows CI, unlike
// a shell that would need a POSIX shell on the Windows runner. It does NOT run
// `prepare-sidecars` itself — that script already handles the cross-compile
// `--target` / `TAURI_TARGET_TRIPLE` cases.

import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..", "..") // repo root, one level above src-tauri/

const STEPS = [
  // The frontend skips its own type check (CODEG_PARALLEL_TSC) because
  // `pnpm typecheck` runs it separately alongside the sidecar compile below.
  { name: "frontend", args: ["build"], env: { CODEG_PARALLEL_TSC: "1" } },
  { name: "sidecar", args: ["tauri:prepare-sidecars"] },
]

// The whole `tauri build` reads as three stages: the two below (frontend,
// sidecar) then Tauri's own cargo compile + bundling, which begins the moment
// this hook exits. We own the first two and announce the third on the way out,
// so the user sees one coherent "stage N/3" progress instead of only cargo's
// per-unit bar deep inside stage 3. There is no meaningful global percentage:
// the stages have wildly different and unpredictable durations, and cargo does
// not know the total up front — the bar advances per stage, not per unit.
const STAGE_TOTAL = 3
const STAGE_LABEL = {
  frontend: "前端导出",
  sidecar: "sidecar 编译（并行 typecheck）",
}

function stageMarker(index, label) {
  const filled = "█".repeat(index)
  const empty = "░".repeat(STAGE_TOTAL - index)
  console.log(
    `\n[before-build] [${filled}${empty}] ${index}/${STAGE_TOTAL} ${label}`
  )
}

function run(step, extraEnv) {
  return new Promise((settle) => {
    const child = spawn("pnpm", step.args, {
      cwd: ROOT,
      stdio: "inherit",
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
      // pnpm is pnpm.cmd on Windows; without a shell the spawn is ENOENT.
      shell: process.platform === "win32",
    })
    child.on("error", (err) => {
      console.error(
        `[before-build] ${step.name}: failed to start — ${err.message}`
      )
      settle(1)
    })
    child.on("exit", (code, signal) => settle(code ?? (signal ? 1 : 0)))
  })
}

async function main() {
  // Order matters: `pnpm build` must finish first. The sidecar compiles
  // codeg_lib with the Tauri runtime on (see prepare-sidecars.mjs), so its
  // `tauri::generate_context!()` reads `../out` at compile time — running it
  // while the frontend export is still rewriting `out/` fails on a missing
  // asset. They cannot overlap; run them back to back.
  const started = Date.now()
  let typecheck = null
  for (const step of STEPS) {
    stageMarker(STEPS.indexOf(step) + 1, STAGE_LABEL[step.name] ?? step.name)
    const t0 = Date.now()
    const code = await run(step, step.env)
    const secs = ((Date.now() - t0) / 1000).toFixed(1)
    if (code !== 0) {
      console.error(
        `[before-build] ${step.name} failed (exit ${code}) after ${secs}s`
      )
      process.exit(code)
    }
    console.log(`[before-build] ${step.name} done in ${secs}s`)
    // The frontend skipped its in-build type check, so start it now and let it
    // run alongside the (much longer) sidecar compile. Same tsconfig, same
    // verdict — a non-zero exit still fails this hook.
    if (step.name === "frontend") {
      const tcStart = Date.now()
      typecheck = {
        code: run({ name: "typecheck", args: ["typecheck"] }).then((code) => ({
          code,
          // tsc's own runtime, not the time we waited for it (it overlaps
          // the sidecar compile, so the wait is longer than the work).
          secs: (Date.now() - tcStart) / 1000,
        })),
      }
    }
  }
  if (typecheck) {
    const { code, secs } = await typecheck.code
    if (code !== 0) {
      console.error(
        `[before-build] typecheck failed (exit ${code}) after ${secs.toFixed(1)}s`
      )
      process.exit(code)
    }
    console.log(`[before-build] typecheck done in ${secs.toFixed(1)}s`)
  }
  // Hand off to Tauri's cargo compile + bundling (stage 3).
  stageMarker(STAGE_TOTAL, "tauri 编译与打包（cargo + bundling）")
  console.log(
    `[before-build] 前置阶段合计 ${((Date.now() - started) / 1000).toFixed(1)}s`
  )
}

main()
