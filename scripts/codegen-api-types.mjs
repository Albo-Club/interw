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
 * The module selection, ordering and identifier mangling below mirror the
 * Convex CLI (`convex/dist/cjs/bundler/index.js` `entryPoints`, and
 * `cli/codegen_templates/api.js` `moduleIdentifier`), so `npx convex dev`
 * rewrites this file with identical content. Re-check them against
 * `node_modules/convex` when bumping `convex`: a divergence shows up as a red
 * `codegen:api:check` right after the next `convex dev`. The `--check` mode
 * exists so CI catches a Convex module added without its codegen committed.
 *
 * Usage:
 *   node scripts/codegen-api-types.mjs          # write
 *   node scripts/codegen-api-types.mjs --check  # exit 2 if out of date
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const convexDir = join(root, 'convex')
const target = join(convexDir, '_generated', 'api.d.ts')

/** File extensions Convex accepts as function modules (`ENTRY_POINT_EXTENSIONS`). */
const ENTRY_POINT = /\.(?:js|mjs|cjs|ts|tsx|mts|cts|jsx)$/

/**
 * Whether Convex pushes this file as a function module — the same rules as its
 * bundler's `entryPoints`, in the same order. A base name with more than one
 * dot is skipped, which is what excludes `*.test.ts`, `*.config.ts` and
 * `*.d.ts`; so is a TypeScript file with no top-level import or export.
 */
function isModule(relPath, fullPath) {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1)
  if (!ENTRY_POINT.test(relPath)) return false
  if (relPath.startsWith('_generated/')) return false
  if (base.startsWith('.') || base.startsWith('#')) return false
  if (base === 'schema.ts' || base === 'schema.js') return false
  if ((base.match(/\./g) ?? []).length > 1) return false
  if (relPath.includes(' ')) return false
  if (/\.tsx?$/.test(base)) {
    return /^\s{0,100}(import|export)/m.test(readFileSync(fullPath, 'utf8'))
  }
  return true
}

/** Module paths relative to `convex/`, extension included. */
function collectModules(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      // A directory with its own convex.config.ts is a nested component,
      // which Convex generates separately.
      if (existsSync(join(full, 'convex.config.ts'))) continue
      out.push(...collectModules(full))
      continue
    }
    const rel = relative(convexDir, full).split('\\').join('/')
    if (isModule(rel, full)) out.push(rel)
  }
  return out
}

/** `lib/auth.ts` → `lib/auth`. */
const importPath = (modulePath) => modulePath.replace(/\.[^./]+$/, '')

// Names Convex suffixes with `_`: its own declarations in api.d.ts, and the
// reserved words (the list in `moduleIdentifier`).
const TAKEN = new Set(
  (
    'fullApi api internal components break case catch class const continue ' +
    'debugger default delete do else export extends false finally for ' +
    'function if import in instanceof new null return super switch this ' +
    'throw true try typeof var void while with let static yield await enum ' +
    'implements interface package private protected public'
  ).split(' '),
)

/** `lib/auth.ts` → `lib_auth`, `class.ts` → `class_`, as Convex mangles them. */
function identifierFor(modulePath) {
  const ident = importPath(modulePath).replace(/[/-]/g, '_')
  return TAKEN.has(ident) ? `${ident}_` : ident
}

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
    .map(
      (m) => `import type * as ${identifierFor(m)} from "../${importPath(m)}.js";`,
    )
    .join('\n')
  const mapLines = modules
    .map((m) => {
      const path = importPath(m)
      // Prettier's `quoteProps: "as-needed"`, which Convex formats with.
      const key = /^[A-Za-z_$][\w$]*$/.test(path) ? path : `"${path}"`
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

// Sorted with the extension on, as Convex does: `lib/ai-gateway.ts` comes
// before `lib/ai.ts` (`-` is 45, `.` is 46); stripped, the order flips.
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
