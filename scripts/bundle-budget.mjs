#!/usr/bin/env node
// Gzip budget for what a candidate's browser downloads to open the interview
// screen. Run after `pnpm build:app`; exits 1 above the budget.
//
// The ESLint boundary on the candidate surface (eslint.config.mjs) catches a
// recruiter component imported by mistake, not slow drift through `~/lib/*` —
// which is how the previous build reached 2.96 MB. This measures the result
// instead of the imports.
//
// What counts: the chunks TanStack Start preloads for each route matched on
// `/s/$token/interview` (read from the server build's start manifest), plus
// everything they import statically. Dynamic `import()` is left out: it loads
// on demand, not before the screen renders.

import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

// KiB (1024 bytes). The measured value when the budget was set: 265.2 KiB.
const BUDGET_KIB = 280
const ROUTES = ['__root__', '/s/$token', '/s/$token/interview']
const SERVER_DIR = '.output/server'
const PUBLIC_DIR = '.output/public'

function fail(message) {
  console.error(`bundle-budget: ${message}`)
  process.exit(1)
}

let manifestFile
try {
  manifestFile = readdirSync(SERVER_DIR).find((f) =>
    /^_tanstack-start-manifest.*\.mjs$/.test(f),
  )
} catch {
  fail(`${SERVER_DIR} not found — run \`pnpm build:app\` first.`)
}
if (!manifestFile) fail(`no start manifest in ${SERVER_DIR}.`)

const { tsrStartManifest } = await import(
  pathToFileURL(resolve(SERVER_DIR, manifestFile)).href
)
const { routes } = tsrStartManifest()

const pending = ROUTES.flatMap((id) => {
  if (!routes[id]) fail(`route ${id} is missing from the start manifest.`)
  return routes[id].preloads ?? []
})

// Static `import … from "./x.js"`, `import "./x.js"` and `export … from
// "./x.js"` in minified output. `import("./x.js")` is excluded by the `(`.
const STATIC_IMPORT = /\b(?:import|export)\s*(?:[^"'();]*?\bfrom\s*)?["']\.\/([^"']+\.js)["']/g

const sizes = new Map()
while (pending.length > 0) {
  const url = pending.pop()
  if (sizes.has(url)) continue
  const code = readFileSync(join(PUBLIC_DIR, url))
  sizes.set(url, gzipSync(code).length)
  const dir = url.slice(0, url.lastIndexOf('/') + 1)
  for (const [, file] of code.toString('utf8').matchAll(STATIC_IMPORT)) {
    pending.push(dir + file)
  }
}

const kib = (bytes) => (bytes / 1024).toFixed(1)
const total = [...sizes.values()].reduce((a, b) => a + b, 0)
for (const [url, size] of [...sizes].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${kib(size).padStart(7)} KiB  ${url}`)
}
console.log(
  `candidate interview: ${sizes.size} chunks, ${kib(total)} KiB gzip (budget ${BUDGET_KIB} KiB)`,
)
if (total > BUDGET_KIB * 1024) {
  fail(`over budget by ${kib(total - BUDGET_KIB * 1024)} KiB.`)
}
