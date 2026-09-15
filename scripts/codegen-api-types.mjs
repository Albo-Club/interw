#!/usr/bin/env node
/**
 * Offline regeneration of `convex/_generated/api.d.ts`.
 *
 * WHY THIS EXISTS
 * `npx convex codegen` needs a reachable deployment: it authenticates against
 * the Convex API before it will write anything. That makes the generated types
 * unreachable from CI and from any environment without deployment credentials
 * — and until they are regenerated, a newly added Convex module simply does
 * not exist as far as `api.*` / `internal.*` typing is concerned, so `tsc`
 * fails on code that is perfectly correct.
 *
 * WHAT IT DOES
 * Only `api.d.ts`, and only the two blocks of it that are mechanically derived
 * from the filesystem: the module map, and the components map read out of
 * `convex/convex.config.ts`. `api.js` is generic at runtime (`anyApi`,
 * `componentsGeneric()`), so nothing here affects behaviour — this is purely
 * about making the type checker see what the runtime already sees.
 *
 * `npx convex dev` overwrites this file with identical content on its next
 * run. The `--check` mode exists so CI catches a Convex module added without
 * its codegen committed.
 *
 * Usage:
 *   node scripts/codegen-api-types.mjs          # write
 *   node scripts/codegen-api-types.mjs --check  # exit 2 if out of date
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const convexDir = join(root, 'convex')
const target = join(convexDir, '_generated', 'api.d.ts')

/** Convex excludes these from the pushed module set. */
function isExcluded(relPath) {
  return (
    relPath.startsWith('_generated/') ||
    relPath === 'schema.ts' ||
    relPath.endsWith('.config.ts') ||
    relPath.endsWith('.d.ts') ||
    /\.test\.tsx?$/.test(relPath)
  )
}

function collectModules(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...collectModules(full))
      continue
    }
    if (!/\.tsx?$/.test(entry.name)) continue
    const rel = relative(convexDir, full).split('\\').join('/')
    if (isExcluded(rel)) continue
    out.push(rel.replace(/\.tsx?$/, ''))
  }
  return out
}

/** `lib/auth` → `lib_auth`, matching Convex's own identifier mangling. */
const identifierFor = (modulePath) => modulePath.replace(/[/-]/g, '_')

/** Read `app.use(pkg)` / `app.use(pkg, { name: 'x' })` out of convex.config.ts. */
function collectComponents() {
  const source = readFileSync(join(convexDir, 'convex.config.ts'), 'utf8')
  const imports = new Map()
  for (const match of source.matchAll(
    /import\s+(\w+)\s+from\s+'([^']+)\/convex\.config'/g,
  )) {
    imports.set(match[1], match[2])
  }
  const components = []
  for (const match of source.matchAll(
    /app\.use\(\s*(\w+)\s*(?:,\s*\{\s*name:\s*'([^']+)'\s*\})?\s*\)/g,
  )) {
    const [, binding, alias] = match
    const pkg = imports.get(binding)
    if (!pkg) continue
    components.push({ name: alias ?? binding, pkg })
  }
  return components
}

function render(modules, components) {
  const importLines = modules
    .map((m) => `import type * as ${identifierFor(m)} from "../${m}.js";`)
    .join('\n')
  const mapLines = modules
    .map((m) => {
      const key = m.includes('/') ? `"${m}"` : m
      return `  ${key}: typeof ${identifierFor(m)};`
    })
    .join('\n')
  const componentLines = components
    .map(
      (c) =>
        `  ${c.name}: import("${c.pkg}/_generated/component.js").ComponentApi<"${c.name}">;`,
    )
    .join('\n')

  return `/* eslint-disable */
/**
 * Generated \`api\` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run \`npx convex dev\`.
 * @module
 */

${importLines}

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
${mapLines}
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * \`\`\`js
 * const myFunctionReference = api.myModule.myFunction;
 * \`\`\`
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * \`\`\`js
 * const myFunctionReference = internal.myModule.myFunction;
 * \`\`\`
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
${componentLines}
};
`
}

const modules = collectModules(convexDir).sort()
const next = render(modules, collectComponents())
const current = readFileSync(target, 'utf8')

if (process.argv.includes('--check')) {
  if (current === next) {
    console.log('convex/_generated/api.d.ts is up to date.')
    process.exit(0)
  }
  console.error(
    'convex/_generated/api.d.ts is stale: a Convex module was added or removed\n' +
      'without committing its codegen. Run `pnpm codegen:api` (or `npx convex dev`).',
  )
  process.exit(2)
}

if (current === next) {
  console.log('convex/_generated/api.d.ts already up to date.')
} else {
  writeFileSync(target, next)
  console.log(`convex/_generated/api.d.ts regenerated (${modules.length} modules).`)
}
