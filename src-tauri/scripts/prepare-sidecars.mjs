#!/usr/bin/env node
//
// Prepare Tauri sidecars before `tauri build` / `tauri dev` consume them.
//
// What it does:
//   1. Resolves the target triple — `--target <triple>` arg, or
//      `TAURI_TARGET_TRIPLE` env, or the host's `rustc -vV` host triple.
//   2. Runs `cargo build --release --bin codeg-mcp --no-default-features`
//      for that triple from `src-tauri/`.
//   3. Copies the produced binary to
//      `src-tauri/binaries/codeg-mcp-<triple>{.exe}` so Tauri's externalBin
//      bundler picks it up under the bare name `codeg-mcp` at install time.
//
// Why a separate script (not inline in beforeBuildCommand / GitHub Actions):
//   - Cross-compile in release.yml passes `--target <triple>` so we honour
//     the matrix triple rather than rebuilding for the host.
//   - Local `pnpm tauri dev` / `pnpm tauri build` invoke it without args and
//     get a host-triple build, so the externalBin lookup still finds a file.
//   - Skippable: set `CODEG_SKIP_SIDECAR=1` when iterating on the frontend
//     and you don't care about delegation.
//
// Intentionally Node-only (no shell): runs identically on macOS, Linux,
// Windows GitHub runners.

import { execFileSync } from "node:child_process"
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  readFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_TAURI = resolve(SCRIPT_DIR, "..")
const BINARIES_DIR = join(SRC_TAURI, "binaries")
const BIN_NAME = "codeg-mcp"

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`)
}

/** True when both files exist and are byte-identical. */
function sameFile(a, b) {
  try {
    const x = readFileSync(a)
    const y = readFileSync(b)
    return x.length === y.length && x.equals(y)
  } catch {
    return false
  }
}

function die(msg) {
  console.error(`[prepare-sidecars][ERROR] ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      args.target = argv[++i]
    } else if (a.startsWith("--target=")) {
      args.target = a.slice("--target=".length)
    }
  }
  return args
}

function resolveHostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"))
    if (!line) throw new Error("rustc -vV missing host: line")
    return line.replace(/^host:\s*/, "").trim()
  } catch (e) {
    die(`cannot determine host triple via rustc -vV: ${e.message}`)
  }
}

function main() {
  if (process.env.CODEG_SKIP_SIDECAR === "1") {
    log("CODEG_SKIP_SIDECAR=1 — skipping sidecar preparation")
    return
  }

  const { target: cliTarget } = parseArgs(process.argv.slice(2))
  const hostTriple = resolveHostTriple()
  const target = cliTarget || process.env.TAURI_TARGET_TRIPLE || hostTriple
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""
  // A host build (no cross --target) must NOT pass `--target`: that would place
  // the sidecar in `target/<triple>/release`, a SEPARATE cargo target dir from
  // the `target/release` that `tauri build` / `tauri dev` use for the host, so
  // every shared dependency gets compiled twice (and ~1GB of disk duplicated).
  // Only a real cross-compile names a triple.
  const crossCompile = target !== hostTriple

  log(
    `target triple: ${target}${crossCompile ? "" : " (host — sharing target/release)"}`
  )

  // cargo build needs to run from src-tauri so it resolves the local manifest
  // and shares the swatinem/rust-cache key with other cargo invocations.
  // `--no-default-features` keeps codeg-mcp free of the Tauri runtime deps —
  // the bin's required-features is empty, so this just enables cross-compile
  // without dragging in macOS-private-api / Linux WebKit / Windows WebView2.
  // Dev runs the sidecar from a DEBUG build: the release profile recompiles the
  // whole codeg lib (minutes), while dev only needs a working local MCP process
  // and the debug artifacts are shared with the `tauri dev` build. Release (the
  // default, and what CI/packaging uses) stays unchanged.
  const debugProfile = process.env.CODEG_SIDECAR_PROFILE === "debug"
  const cargoArgs = ["build", "--bin", BIN_NAME]
  if (!debugProfile) cargoArgs.push("--release")
  if (crossCompile) {
    // Cross build: keep the sidecar free of the Tauri runtime so it compiles
    // without the target's WebKit/WebView2 stack. This is a SEPARATE feature
    // set from the host `tauri build`, so it compiles codeg_lib on its own —
    // unavoidable, and the CI path stages this sidecar before the bundle and
    // skips the beforeBuildCommand pass anyway.
    cargoArgs.push("--no-default-features", "--target", target)
  } else {
    // Host build: match the `tauri build` feature set exactly (default features
    // + tauri/custom-protocol) so codeg_lib is compiled ONCE and shared with the
    // main binary instead of a second time under --no-default-features. The
    // staged sidecar links the Tauri glue as a result; it is larger but the
    // packaging build drops the duplicate lib compile.
    cargoArgs.push("--features", "tauri/custom-protocol")
  }

  // Log the real cargo args (the host and cross paths differ in features).
  log(`cargo ${cargoArgs.join(" ")}`)
  execFileSync("cargo", cargoArgs, { stdio: "inherit", cwd: SRC_TAURI })

  const built = join(
    SRC_TAURI,
    "target",
    ...(crossCompile ? [target] : []),
    debugProfile ? "debug" : "release",
    `${BIN_NAME}${ext}`
  )
  if (!existsSync(built)) {
    die(`expected ${built} after cargo build, but it does not exist`)
  }

  mkdirSync(BINARIES_DIR, { recursive: true })
  const dest = join(BINARIES_DIR, `${BIN_NAME}-${target}${ext}`)
  // Skip when the staged file already matches. A needless copy still bumps the
  // mtime, and Tauri tracks `bundle.externalBin` (tauri-build, and this crate's
  // own build.rs), so a no-op touch dirties the giant codeg crate for nothing.
  if (sameFile(built, dest)) {
    log(`sidecar unchanged — ${dest} left as is`)
  } else {
    copyFileSync(built, dest)
    if (!isWindows) {
      // copyFileSync preserves modes on POSIX, but be explicit for tarball
      // sources that may strip the +x bit.
      chmodSync(dest, 0o755)
    }
    log(`sidecar staged at ${dest}`)
  }
}

main()
