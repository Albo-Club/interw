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
 * And, in every case, the guard must come BEFORE the handler's first write.
 * A guard that runs after the row is already patched is not a guard, and a
 * substring search cannot tell the two apart on its own.
 *
 * A function that is genuinely allowed to be open declares it with a
 * `// access: <reason>` comment on the line above its export, which is
 * recorded in the output so the exceptions stay few and visible.
 *
 * WHAT THIS CANNOT DO, stated here rather than implied by silence: it cannot
 * check that the guard is applied to the RIGHT thing. `requireOrgMember(ctx,
 * args.orgId)` in a function that then reads a row belonging to a different
 * organisation passes this audit and is a confused-deputy bug. Tying an
 * argument to a guard needs a parse of the handler, not a search over its
 * text; until this script has one, that property is held by review and by the
 * `withIdentity` tests in convex/guards.test.ts, and this script's claim is
 * the narrower "every public function is guarded, before it writes".
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
  'crons.ts',
  'email.ts',
  'emailTemplates.ts',
  'rateLimiters.ts',
  'agent.ts',
  'publicConfig.ts',
])

/**
 * Calls that change state. A guard that appears after one of these has
 * already let the write happen.
 *
 * `ctx.runMutation` is deliberately absent: an action delegating to an
 * internal mutation is the normal shape here, and rule 3 checks that the
 * mutation it delegates to is itself guarded.
 */
const WRITES = [
  'ctx.db.insert(',
  'ctx.db.patch(',
  'ctx.db.delete(',
  'ctx.db.replace(',
  'ctx.scheduler.runAfter(',
  'ctx.scheduler.runAt(',
]

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
    /(?:^|\n)((?:\/\/[^\n]*\n)+)?export const (\w+) = (query|mutation|action|internalQuery|internalMutation|internalAction|httpAction)\(/g
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

/**
 * Drop comments before looking for a guard.
 *
 * Without this, `// requireOrgMember is not needed here, the token is the
 * check` is indistinguishable from calling it — the audit reads a note about
 * why a guard is absent as the guard itself.
 *
 * Line comments are only stripped when the `//` is not preceded by a colon,
 * so the `https://` in a URL survives. Good enough for deciding whether a
 * call is present, which is all this is for.
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Guards named by this text, matched as calls rather than as substrings.
 *
 * The substring version reported `sharedMediaUrls → resolveShare` — an action,
 * with no `ctx.db`, that never calls `resolveShare`: the match was inside
 * `resolveSharedMedia`. The verdict was right by accident, which is the worst
 * way for an audit to be right.
 */
function namesAGuard(text) {
  const code = stripComments(text)
  return GUARDS.filter((guard) => new RegExp(`\\b${guard}\\s*\\(`).test(code))
}

/** Where the first guard call appears, or -1. */
function guardIndex(text) {
  const code = stripComments(text)
  let first = -1
  for (const guard of GUARDS) {
    const match = new RegExp(`\\b${guard}\\s*\\(`).exec(code)
    if (match && (first === -1 || match.index < first)) first = match.index
  }
  return first
}

/** Where the handler first changes state, or -1. */
function writeIndex(text) {
  const code = stripComments(text)
  let first = -1
  for (const write of WRITES) {
    const at = code.indexOf(write)
    if (at !== -1 && (first === -1 || at < first)) first = at
  }
  return first
}

/**
 * Routes declared inline in http.ts, which are public endpoints on the
 * `.convex.site` URL like any other.
 *
 * They are not `export const NAME = httpAction(...)`, so the declaration regex
 * above cannot see them — which is why `http.ts` used to sit in SKIP and no
 * HTTP endpoint was audited at all.
 */
function httpRoutes(source) {
  const found = []
  const re = /(?:^|\n)((?:\/\/[^\n]*\n)+)?http\.route\(\{([\s\S]*?)\n\}\)/g
  let match
  while ((match = re.exec(source))) {
    const [, comment, block] = match
    const path = /path:\s*'([^']+)'/.exec(block)?.[1] ?? '(unknown path)'
    const method = /method:\s*'([^']+)'/.exec(block)?.[1] ?? '?'
    // `handler: someExport` points at a function audited in its own module.
    const delegated = /handler:\s*(\w+)\s*,?\s*$/m.exec(block)?.[1]
    found.push({
      name: `${method} ${path}`,
      kind: 'httpAction',
      exemption: comment?.includes('access:')
        ? comment
            .split('\n')
            .map((line) => line.replace(/^\/\/\s?/, '').trim())
            .join(' ')
            .replace(/access:\s*/, '')
            .trim()
        : null,
      body: block,
      delegated,
    })
  }
  return found
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
  const declared = [
    ...declarations(source),
    ...(file === 'http.ts' ? httpRoutes(source) : []),
  ]
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

    // An http.ts route whose handler is an export from another module is
    // audited there, under its own name.
    if (!via && decl.delegated) via = `handler ${decl.delegated}`

    // A guard that runs after the write already happened is not a guard.
    const firstGuard = guardIndex(decl.body)
    const firstWrite = writeIndex(decl.body)
    const guardAfterWrite =
      via === 'direct' && firstWrite !== -1 && firstWrite < firstGuard

    rows.push({
      file,
      name: decl.name,
      kind: decl.kind,
      isPublic,
      guards,
      via,
      guardAfterWrite,
      exemption: decl.exemption,
    })
  }
}

const unguarded = rows.filter(
  (row) => row.isPublic && !row.exemption && (!row.via || row.guardAfterWrite),
)

if (!process.argv.includes('--check')) {
  const width = Math.max(...rows.map((row) => row.file.length))
  for (const row of rows) {
    const visibility = row.isPublic ? 'PUBLIC  ' : 'internal'
    const how = row.exemption
      ? `open — ${row.exemption}`
      : row.guardAfterWrite
        ? `${row.guards.join(', ')} — AFTER A WRITE`
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
      unguarded
        .map(
          (row) =>
            `  ${row.file} → ${row.name}` +
            (row.guardAfterWrite ? '  (guard runs AFTER a write)' : ''),
        )
        .join('\n') +
      '\n\nAdd a require*/token guard before the first write, or declare the\n' +
      'exception with a `// access: <reason>` comment above the export.',
  )
  process.exit(2)
}
