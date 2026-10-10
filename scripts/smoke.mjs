/**
 * Release smoke test: pack the package the way npm would, then verify the
 * tarball is self-consistent and loadable.
 *
 * Checks:
 *   - required files are present in the tarball
 *   - every `exports` target resolves to a file in the tarball
 *   - both the main (`.`) and TUI (`./tui`) entrypoints are declared
 *   - the packed pure modules can be imported as-is
 *   - the packed entrypoints bundle (JSX + externals) without error
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { tmpdir } from "node:os"

const REQUIRED_FILES = [
  "package.json",
  "README.md",
  "LICENSE",
  "src/index.ts",
  "src/tui.tsx",
  "src/controller.ts",
  "src/meter.ts",
  "src/display.ts",
]

function fail(message) {
  throw new Error(`smoke: ${message}`)
}

const temp = mkdtempSync(join(tmpdir(), "opencode-tok-sec-smoke-"))

try {
  const raw = execFileSync("npm", ["pack", "--json", "--pack-destination", temp], {
    cwd: process.cwd(),
    encoding: "utf8",
  }),
    [info] = JSON.parse(raw),
    files = info.files.map((entry) => entry.path),
    missing = REQUIRED_FILES.filter((file) => !files.includes(file))
  if (missing.length > 0) {
    fail(`tarball is missing: ${missing.join(", ")}`)
  }

  execFileSync("tar", ["xzf", join(temp, info.filename), "-C", temp])
  const extracted = join(temp, "package"),
    pkg = JSON.parse(readFileSync(join(extracted, "package.json"), "utf8"))

  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const target = typeof value === "string" ? value : value?.import
    if (!target || !existsSync(join(extracted, target))) {
      fail(`export "${key}" -> "${target}" does not resolve`)
    }
  }
  if (!pkg.exports?.["."] || !pkg.exports?.["./tui"]) {
    fail('package.json exports must include "." and "./tui"')
  }

  const meter = await import(join(extracted, "src", "meter.ts")),
    display = await import(join(extracted, "src", "display.ts"))
  if (
    typeof display.formatLine !== "function" ||
    typeof meter.TpsMeter !== "function"
  ) {
    fail("packed src/meter.ts + src/display.ts did not export the expected API")
  }

  const controller = await import(join(extracted, "src", "controller.ts"))
  if (typeof controller.createMeterController !== "function") {
    fail("packed src/controller.ts did not export createMeterController")
  }

  const esbuild = await import("esbuild")
  for (const entry of ["src/index.ts", "src/tui.tsx"]) {
    try {
      await esbuild.build({
        entryPoints: [join(extracted, entry)],
        bundle: true,
        write: false,
        format: "esm",
        platform: "node",
        jsx: "automatic",
        jsxImportSource: "@opentui/solid",
        external: ["@opencode/*", "@opentui/*", "solid-js", "solid-js/*"],
      })
    } catch (error) {
      fail(`${entry} failed to bundle: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  console.info(`smoke: OK (${files.length} files, ${info.filename})`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
