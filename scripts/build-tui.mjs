// Build the TUI entry the way the host expects an npm plugin to arrive.
//
// opencode only applies its Solid JSX transform to files OUTSIDE node_modules
// (see "bun-plugin-solid" in the host: the loader filter is
// /^(?!.*node_modules).*\.[cm]?[jt]sx?$/). A plugin installed from npm lives in
// node_modules, so raw .tsx arrives untransformed, ends up bound to its own copy
// of the runtime, and the host cannot render its slots — the plugin's logic runs
// while the UI silently never draws.
//
// The mature plugins ship pre-compiled JS for exactly this reason. So do the
// same: run the identical transform (babel-preset-solid, moduleName
// "@opentui/solid", generate "universal", plus the TypeScript preset), then
// bundle with the runtime left external. The host maps those specifiers to its
// own runtime for packages under node_modules, so one runtime is shared.

import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

const SRC = "src"
const TMP = ".build-tui"
const OUT = "dist"

await rm(TMP, { recursive: true, force: true })
await mkdir(TMP, { recursive: true })

for (const file of await readdir(SRC)) {
  if (!/\.(ts|tsx)$/.test(file)) continue
  const source = await readFile(join(SRC, file), "utf8")
  const result = await transformAsync(source, {
    filename: join(SRC, file),
    configFile: false,
    babelrc: false,
    presets: [
      [solid, { moduleName: "@opentui/solid", generate: "universal" }],
      [typescript],
    ],
  })
  await writeFile(join(TMP, file.replace(/\.tsx?$/, ".js")), result?.code ?? source)
}

const built = await Bun.build({
  entrypoints: [join(TMP, "index.js")],
  outdir: OUT,
  target: "bun",
  format: "esm",
  naming: "tui.js",
  external: ["solid-js", "@opentui/solid", "@opencode-ai/plugin"],
})

if (!built.success) {
  for (const log of built.logs) console.error(log)
  process.exit(1)
}

const bundle = await readFile(join(OUT, "tui.js"), "utf8")
const runtimes = [...new Set(bundle.match(/from"[^"]*"/g) ?? [])].sort()
console.log(`built ${OUT}/tui.js (${(bundle.length / 1024).toFixed(1)} kB)`)
console.log("external imports:", runtimes.join(" "))

await rm(TMP, { recursive: true, force: true })
