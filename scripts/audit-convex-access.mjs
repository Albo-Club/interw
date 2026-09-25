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
 *   node scripts/audit-convex-access.mjs --check  # exit 2 on any finding
 *
 * WHICH FUNCTIONS. The list of public functions is not this script's parse:
 * it is the `api` object's type in `convex/_generated/api.d.ts`, read with the
 * TypeScript checker — what a client can actually call. The parse below only
 * reads the plain `export const name = query|mutation|action({ ... })` shape;
 * a public function it cannot read (`export { f }`, `export default`, an
 * aliased builder, a shape nobody uses yet) is UNCLASSIFIED and fails the
 * check, rather than going unlisted. `pnpm codegen:api:check` keeps that file
 * in step with the modules on disk. HTTP routes are not in `api`; the inline
 * `http.route(...)` calls in http.ts are audited from the parse. Routes
 * registered by a library (`authComponent.registerRoutes`) are not.
 *
 * GUARDED BEFORE WRITING. In a function's text, the first guard must come
 * before the first write. A guard is:
 *   - a call to one of GUARDS;
 *   - a call to a helper whose own text is guarded before it writes — a
 *     top-level `function` in the same module or imported by name from a
 *     relative module, followed through as many hops as it takes;
 *   - a `run{Query,Mutation,Action}(internal.x.y | api.x.y)` whose target is
 *     itself guarded before it writes — which is how every action here works,
 *     since actions have no ctx.db.
 * A write is a call in WRITES, a call to a helper that writes before it
 * guards, or a `runMutation`/`runAction` whose target is not guarded (an
 * internal function, a component) — an unguarded internal mutation that
 * writes before the delegated guard is still a write before the guard.
 *
 * An `// access: <reason>` comment on the lines directly above an export
 * declares a function that is genuinely open. The reason is printed, so the
 * exceptions stay few and visible.
 *
 * WHAT THIS CANNOT DO, stated here rather than implied by silence:
 *   - It reads text order, not control flow. A guard inside an `if`, a
 *     callback or dead code counts as if it always ran; a write in a closure
 *     defined before the guard counts as if it ran there. It follows calls by
 *     name — not methods, arrow-function helpers, re-exports or values passed
 *     around — so an effect reached that way is invisible to it.
 *   - It cannot check that the guard is applied to the RIGHT thing.
 *     `requireOrgMember(ctx, args.orgId)` in a function that then reads a row
 *     of a different organisation passes this audit and is a confused-deputy
 *     bug. That property is held by review and by the `withIdentity` tests in
 *     convex/guards.test.ts.
 * So its claim is the narrower one: every public function reaches a guard,
 * as written, before any write it can see.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('..', import.meta.url))
const convexDir = join(root, 'convex')

/**
 * Calls that change state, or that let someone else change it. A guard that
 * appears after one of these has already let the effect happen. Matched on
 * the call, whatever the context object is called.
 */
const WRITES = [
  '.db.insert(',
  '.db.patch(',
  '.db.delete(',
  '.db.replace(',
  '.scheduler.runAfter(',
  '.scheduler.runAt(',
  // A rate-limit token is a write to the limiter component: consuming one
  // before the guard lets an unauthenticated caller write limiter rows.
  'consumeLimit(',
  'rateLimiter.limit(',
  'rateLimiter.reset(',
  // Storage and the object store: a deletion, or a URL that lets its holder
  // write.
  '.storage.delete(',
  '.storage.store(',
  '.storage.generateUploadUrl(',
  'deleteObjects(',
  'presignPut(',
  // An email cannot be taken back.
  '.sendEmail(',
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
  // The template's own identity helpers: both resolve the caller server-side
  // and return null / throw when there is nobody authenticated.
  'safeAppUser',
  'provisionAppUser',
  // Candidate surface: resolving a token IS the access check.
  'resolveSessionByToken',
  // A role's public link: resolving its apply token IS the access check.
  'requireApplyProject',
]

const KINDS = new Set([
  'query',
  'mutation',
  'action',
  'internalQuery',
  'internalMutation',
  'internalAction',
  'httpAction',
])

/** Convex function modules: one dot in the name, not generated. */
function listModules(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '_generated') continue
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      out.push(...listModules(join(dir, entry.name), rel))
    } else if (/^[^.]+\.(?:ts|tsx|js|mjs|cjs|mts|cts|jsx)$/.test(entry.name)) {
      out.push(rel)
    }
  }
  return out
}

/**
 * The `// access: <reason>` exemption: the run of `//` lines directly above
 * `node`, with no blank line between them, if it contains the marker. The
 * reason may span several lines.
 */
function exemptionOf(node) {
  const source = node.getSourceFile().text
  const ranges = ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []
  const block = []
  let next = node.getStart()
  for (const range of ranges.toReversed()) {
    const gap = source.slice(range.end, next)
    if (range.kind !== ts.SyntaxKind.SingleLineCommentTrivia) break
    if (!/^\r?\n$/.test(gap)) break
    block.unshift(source.slice(range.pos, range.end))
    next = range.pos
  }
  if (!block.some((line) => line.includes('access:'))) return null
  return block
    .map((line) => line.replace(/^\/\/\s?/, '').trim())
    .join(' ')
    .replace(/access:\s*/, '')
    .trim()
}

const isExported = (node) =>
  node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false

/**
 * One module: its `export const NAME = kind({ ... })` functions, its
 * top-level `function` helpers, the names it imports from sibling modules,
 * and — in http.ts — its inline routes.
 *
 * Read from the TypeScript syntax tree rather than cut at the first `\n})`:
 * a handler with a nested object closing at column 0 used to end the body
 * early, and everything after it — guards and writes alike — went unread.
 */
function parseModule(file) {
  const path = file.replace(/\.[^.]+$/, '')
  const source = readFileSync(join(convexDir, file), 'utf8')
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const mod = {
    file,
    path,
    functions: new Map(),
    helpers: new Map(),
    imports: new Map(),
    routes: [],
  }
  for (const statement of tree.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.body) {
      mod.helpers.set(statement.name.text, statement.body.getText(tree))
    } else if (
      ts.isImportDeclaration(statement) &&
      statement.moduleSpecifier.text.startsWith('.') &&
      statement.importClause?.namedBindings &&
      ts.isNamedImports(statement.importClause.namedBindings)
    ) {
      const from = posix
        .normalize(posix.join(posix.dirname(path), statement.moduleSpecifier.text))
        .replace(/\.[^./]+$/, '')
      for (const element of statement.importClause.namedBindings.elements) {
        mod.imports.set(element.name.text, {
          path: from,
          name: (element.propertyName ?? element.name).text,
        })
      }
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const decl of statement.declarationList.declarations) {
        const init = decl.initializer
        if (!init || !ts.isCallExpression(init)) continue
        if (!ts.isIdentifier(init.expression)) continue
        if (!KINDS.has(init.expression.text) || !ts.isIdentifier(decl.name)) continue
        mod.functions.set(decl.name.text, {
          name: decl.name.text,
          kind: init.expression.text,
          exemption: exemptionOf(statement),
          body: init.arguments.map((arg) => arg.getText(tree)).join(', '),
        })
      }
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isCallExpression(statement.expression) &&
      statement.expression.expression.getText(tree) === 'http.route'
    ) {
      const options = statement.expression.arguments[0]
      const block = options?.getText(tree) ?? ''
      const path = /path:\s*'([^']+)'/.exec(block)?.[1] ?? '(unknown path)'
      const method = /method:\s*'([^']+)'/.exec(block)?.[1] ?? '?'
      // `handler: someExport` points at a function audited in its own module.
      const handler =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p) => ts.isPropertyAssignment(p) && p.name.getText(tree) === 'handler',
            )
          : undefined
      mod.routes.push({
        name: `${method} ${path}`,
        kind: 'httpAction',
        exemption: exemptionOf(statement),
        body: block,
        delegated:
          handler && ts.isIdentifier(handler.initializer)
            ? handler.initializer.text
            : undefined,
      })
    }
  }
  return mod
}

/**
 * Drop comments before looking for calls.
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

const modules = new Map(
  listModules(convexDir).map((file) => {
    const mod = parseModule(file)
    return [mod.path, mod]
  }),
)

/** The helper `name` names in `mod`, declared there or imported by name. */
function resolveHelper(mod, name) {
  if (mod.helpers.has(name)) return { mod, name }
  const imported = mod.imports.get(name)
  const from = imported && modules.get(imported.path)
  return from?.helpers.has(imported.name) ? { mod: from, name: imported.name } : null
}

/** `internal.lib.x.f` → the function `f` of module `lib/x`, if parsed. */
function resolveFunction(reference) {
  const [, ...segments] = reference.split('.')
  const mod = modules.get(segments.slice(0, -1).join('/'))
  return mod?.functions.has(segments.at(-1)) ? { mod, name: segments.at(-1) } : null
}

const memo = new Map()

/**
 * Where `body` first reaches a guard and first writes, following helpers and
 * delegated functions (see the header). `guarded` is the verdict: a guard is
 * reached, and before any write.
 */
function scan(key, body, mod) {
  if (memo.has(key)) return memo.get(key)
  // A cycle counts as neither a guard nor a write until it resolves.
  memo.set(key, { guarded: false, guardAt: -1, write: -1, label: null })

  const code = stripComments(body)
  let guard = null
  let write = -1
  const reach = (at, label) => {
    if (!guard || at < guard.at) guard = { at, label }
  }
  const wrote = (at) => {
    if (write === -1 || at < write) write = at
  }

  for (const name of GUARDS) {
    const match = new RegExp(`\\b${name}\\s*\\(`).exec(code)
    if (match) reach(match.index, name)
  }
  for (const call of WRITES) {
    const at = code.indexOf(call)
    if (at !== -1) wrote(at)
  }
  for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (GUARDS.includes(match[1])) continue
    const helper = resolveHelper(mod, match[1])
    if (!helper) continue
    const facts = scan(
      `${helper.mod.path}#${helper.name}`,
      helper.mod.helpers.get(helper.name),
      helper.mod,
    )
    if (facts.guarded) reach(match.index, `${match[1]} → ${facts.label}`)
    else if (facts.write !== -1) wrote(match.index)
  }
  for (const match of code.matchAll(/\.run(Query|Mutation|Action)\(\s*([\w.]+)/g)) {
    const target = /^(internal|api)\./.test(match[2])
      ? resolveFunction(match[2])
      : null
    const facts = target && functionFacts(target.mod, target.name)
    if (facts?.guarded) reach(match.index, `${match[2]} → ${facts.label}`)
    else if (match[1] !== 'Query') wrote(match.index)
  }

  const result = {
    guarded: guard !== null && (write === -1 || guard.at < write),
    guardAt: guard?.at ?? -1,
    write,
    label: guard?.label ?? null,
  }
  memo.set(key, result)
  return result
}

function functionFacts(mod, name) {
  return scan(`${mod.path}.${name}`, mod.functions.get(name).body, mod)
}

/** The public functions a client can call, from the generated `api` type. */
function publicApi() {
  const config = ts.getParsedCommandLineOfConfigFile(
    join(convexDir, 'tsconfig.json'),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} },
  )
  const apiFile = join(convexDir, '_generated', 'api.d.ts')
  const program = ts.createProgram([apiFile], config.options)
  const checker = program.getTypeChecker()
  const api = checker
    .getExportsOfModule(checker.getSymbolAtLocation(program.getSourceFile(apiFile)))
    .find((symbol) => symbol.name === 'api')
  const found = []
  const walk = (type, path) => {
    // A FunctionReference; anything else is a (nested) module.
    if (type.getProperty('_visibility')) {
      found.push({ path: path.slice(0, -1).join('/'), name: path.at(-1) })
      return
    }
    for (const property of type.getProperties()) {
      walk(checker.getTypeOfSymbol(property), [...path, property.name])
    }
  }
  walk(checker.getTypeOfSymbol(api), [])
  return found
}

const rows = []
for (const mod of modules.values()) {
  for (const fn of mod.functions.values()) {
    rows.push({ file: mod.file, ...fn, facts: functionFacts(mod, fn.name) })
  }
  for (const route of mod.routes) {
    // A route whose handler is an export of another module is audited there,
    // under its own name.
    const facts = route.delegated
      ? { guarded: true, guardAt: 0, write: -1, label: `handler ${route.delegated}` }
      : scan(`${mod.path} ${route.name}`, route.body, mod)
    rows.push({ file: mod.file, ...route, facts })
  }
}

const unclassified = publicApi().filter(
  ({ path, name }) => !modules.get(path)?.functions.get(name),
)
const failing = rows.filter(
  (row) => !row.kind.startsWith('internal') && !row.exemption && !row.facts.guarded,
)
const afterWrite = (row) => row.facts.guardAt !== -1

if (!process.argv.includes('--check')) {
  const width = Math.max(...rows.map((row) => row.file.length))
  for (const row of rows) {
    const visibility = row.kind.startsWith('internal') ? 'internal' : 'PUBLIC  '
    const how = row.exemption
      ? `open — ${row.exemption}`
      : row.facts.guarded
        ? row.facts.label
        : afterWrite(row)
          ? `${row.facts.label} — AFTER A WRITE`
          : '— none —'
    console.log(
      `${visibility} ${row.file.padEnd(width)} ${row.name.padEnd(24)} ${how}`,
    )
  }
  console.log(
    `\n${rows.filter((r) => !r.kind.startsWith('internal')).length} public functions, ` +
      `${failing.length} without an access check before their first write, ` +
      `${unclassified.length} unclassified.`,
  )
}

if (unclassified.length > 0) {
  console.error(
    '\nPublic Convex functions this audit cannot read:\n' +
      unclassified.map(({ path, name }) => `  ${path} → ${name}`).join('\n') +
      '\n\nDeclare them as `export const name = query|mutation|action({ ... })`\n' +
      'with the builder imported from ./_generated/server under its own name.',
  )
}
if (failing.length > 0) {
  console.error(
    '\nPublic Convex functions with no access check before their first write:\n' +
      failing
        .map(
          (row) =>
            `  ${row.file} → ${row.name}` +
            (afterWrite(row) ? '  (guard runs AFTER a write)' : ''),
        )
        .join('\n') +
      '\n\nAdd a require*/token guard before the first write, or declare the\n' +
      'exception with a `// access: <reason>` comment above the export.',
  )
}
if (unclassified.length > 0 || failing.length > 0) process.exit(2)
