#!/usr/bin/env node
/**
 * Every public Convex function must check access before it does anything.
 *
 * Convex has no row-level security: a public function is callable by anyone
 * who knows the deployment URL. The rule (see CLAUDE.md and the rebuild brief)
 * is that a function touching organisation data calls one of the `require*`
 * guards first, and a candidate-facing function resolves its token first.
 *
 * "Verified function by function, not assumed" only stays true if something
 * keeps verifying. This does, on every push:
 *
 *   node scripts/audit-convex-access.mjs          # print the matrix
 *   node scripts/audit-convex-access.mjs --check  # exit 2 on an unguarded fn
 *
 * How it decides a function is guarded:
 *   1. the handler names a guard directly; or
 *   2. the handler calls a local helper that names one (one hop); or
 *   3. the handler delegates through ctx.runQuery/runMutation to an
 *      `internal.*` function in the same file that is itself guarded — which
 *      is how every action here works, since actions have no ctx.db.
 *
 * A function that is genuinely allowed to be open declares it with a
 * `// access: <reason>` comment on the line above its export, which is
 * recorded in the output so the exceptions stay few and visible.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const convexDir = join(root, 'convex')

/** Modules that carry no user data and are audited by inspection instead. */
const SKIP = new Set([
  'schema.ts',
  'convex.config.ts',
  'auth.config.ts',
  'auth.ts',
  'http.ts',
  'crons.ts',
  'email.ts',
  'emailTemplates.ts',
  'rateLimiters.ts',
  'agent.ts',
  'publicConfig.ts',
])

const GUARDS = [
  'requireAppUser',
  'requireOrgMember',
  'requireOrgRole',
  'requireSuperAdmin',
  'requireProjectAccess',
  'requireProjectEditable',
  'requireProjectOwnerOrAdmin',
  'requireSession',
  'requireOpenSession',
  'resolveShare',
  'readMembership',
  'parseScope',
  // The template's own identity helpers: both resolve the caller server-side
  // and return null / throw when there is nobody authenticated.
  'safeAppUser',
  'provisionAppUser',
  // Candidate surface: resolving a token IS the access check.
  'resolveSessionByToken',
]

function listModules(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '_generated') continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...listModules(join(dir, entry.name), rel))
    } else if (/\.ts$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

/** Body of a top-level `export const NAME = kind({ ... })` declaration. */
function declarations(source) {
  // The exemption marker may sit anywhere in the contiguous `//` comment
  // block above the export, so a reason can be written across several lines.
  const re =
    /(?:^|\n)((?:\/\/[^\n]*\n)+)?export const (\w+) = (query|mutation|action|internalQuery|internalMutation|internalAction)\(/g
  const found = []
  let match
  while ((match = re.exec(source))) {
    const [, comment, name, kind] = match
    const exemption = comment?.includes('access:')
      ? comment
          .split('\n')
          .map((line) => line.replace(/^\/\/\s?/, '').trim())
          .join(' ')
          .replace(/^access:\s*/, '')
          .replace(/access:\s*/, '')
          .trim()
      : null
    const start = match.index + match[0].length
    const end = source.indexOf('\n})', start)
    found.push({
      name,
      kind,
      exemption,
      body: source.slice(start, end === -1 ? source.length : end),
    })
  }
  return found
}

function namesAGuard(text) {
  return GUARDS.filter((guard) => text.includes(guard))
}

/** Local `async function helper(...)` bodies, for the one-hop resolution. */
function localHelpers(source) {
  const helpers = new Map()
  const re = /\n(?:export )?(?:async )?function (\w+)\(/g
  let match
  while ((match = re.exec(source))) {
    const start = match.index
    const end = source.indexOf('\n}', start)
    helpers.set(match[1], source.slice(start, end === -1 ? source.length : end))
  }
  return helpers
}

const rows = []
for (const file of listModules(convexDir)) {
  if (SKIP.has(file)) continue
  const source = readFileSync(join(convexDir, file), 'utf8')
  const helpers = localHelpers(source)
  const declared = declarations(source)
  const byName = new Map(declared.map((d) => [d.name, d]))

  for (const decl of declared) {
    const isPublic = !decl.kind.startsWith('internal')
    let guards = namesAGuard(decl.body)
    let via = guards.length > 0 ? 'direct' : null

    // 2. one hop through a local helper.
    if (!via) {
      for (const [helperName, helperBody] of helpers) {
        if (!decl.body.includes(`${helperName}(`)) continue
        const helperGuards = namesAGuard(helperBody)
        if (helperGuards.length > 0) {
          guards = helperGuards
          via = `helper ${helperName}`
          break
        }
      }
    }

    // 3. delegation to a guarded internal function in the same module.
    if (!via) {
      for (const [otherName, other] of byName) {
        if (otherName === decl.name) continue
        if (!decl.body.includes(`.${otherName},`)) continue
        const otherGuards = namesAGuard(other.body)
        const otherHelper = [...helpers].find(
          ([helperName, helperBody]) =>
            other.body.includes(`${helperName}(`) &&
            namesAGuard(helperBody).length > 0,
        )
        if (otherGuards.length > 0 || otherHelper) {
          guards = otherGuards.length > 0 ? otherGuards : namesAGuard(otherHelper[1])
          via = `delegates to ${otherName}`
          break
        }
      }
    }

    rows.push({
      file,
      name: decl.name,
      kind: decl.kind,
      isPublic,
      guards,
      via,
      exemption: decl.exemption,
    })
  }
}

const unguarded = rows.filter(
  (row) => row.isPublic && !row.via && !row.exemption,
)

if (!process.argv.includes('--check')) {
  const width = Math.max(...rows.map((row) => row.file.length))
  for (const row of rows) {
    const visibility = row.isPublic ? 'PUBLIC  ' : 'internal'
    const how = row.exemption
      ? `open — ${row.exemption}`
      : row.via
        ? `${row.guards.join(', ')} (${row.via})`
        : '— none —'
    console.log(
      `${visibility} ${row.file.padEnd(width)} ${row.name.padEnd(24)} ${how}`,
    )
  }
  console.log(
    `\n${rows.filter((r) => r.isPublic).length} public functions, ` +
      `${unguarded.length} without an access check.`,
  )
}

if (unguarded.length > 0) {
  console.error(
    '\nPublic Convex functions with no access check:\n' +
      unguarded.map((row) => `  ${row.file} → ${row.name}`).join('\n') +
      '\n\nAdd a require*/token guard, or declare the exception with a\n' +
      '`// access: <reason>` comment directly above the export.',
  )
  process.exit(2)
}
