#!/usr/bin/env node
//
// Pre-build hook for `tauri build` (desktop bundling).
//
// Tauri runs `beforeBuildCommand` to completion before it ever starts the main
// cargo build, so everything it needs must be ready when this exits:
//   * `pnpm build`                  — Next static export → out/ (bundle.resources)
//   * `pnpm tauri:prepare-sidecars` — codeg-mcp release sidecar → binaries/
//
// They use different toolchains and write different trees, so run them at the
// same time: on a cold build that overlaps the frontend export with the sidecar
// compile and saves ~min(frontend, sidecar) of wall clock. Both must succeed —
// a failure in either fails this hook, so Tauri never starts against a partial
// out/ or a missing sidecar.
//
// Set CODEG_SERIAL_BEFORE_BUILD=1 to force the old back-to-back order (debugging
// a failure, or a low-core machine where the two compete too hard for CPU).
//
// Node-only on purpose: runs identically on macOS, Linux and Windows CI, unlike
// a shell `&`/`wait` (which would need a POSIX shell and would not survive the
// Windows runner). It does NOT run `prepare-sidecars` itself — that script
// already handles the cross-compile `--target` / `TAURI_TARGET_TRIPLE` cases.

import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, "..", "..") // repo root, one level above src-tauri/

const STEPS = [
  { name: "frontend", args: ["build"] },
  { name: "sidecar", args: ["tauri:prepare-sidecars"] },
]

function run(step) {
  return new Promise((settle) => {
    const child = spawn("pnpm", step.args, {
      cwd: ROOT,
      stdio: "inherit",
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
  // `pnpm <script>` for each step; a non-zero exit is fatal.
  if (process.env.CODEG_SERIAL_BEFORE_BUILD === "1") {
    for (const step of STEPS) {
      const code = await run(step)
      if (code !== 0) process.exit(code)
    }
    return
  }

  const codes = await Promise.all(STEPS.map(run))
  const failedAt = codes.findIndex((code) => code !== 0)
  if (failedAt !== -1) {
    console.error(
      `[before-build] ${STEPS[failedAt].name} failed (exit ${codes[failedAt]})`
    )
    process.exit(codes[failedAt])
  }
}

main()
