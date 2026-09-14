#!/usr/bin/env node
// Automated smoke tests for albo-ouvre-boite.
// Covers: dev server reachability, security headers, public routes,
// Better Auth proxy health, anonymous API sanity, HTML response shape.
//
// Usage:
//   pnpm run dev                   # in another terminal
//   pnpm run test:smoke            # this script
//   pnpm run test:smoke -- --url https://your-deployment
//
// Exit codes:
//   0   all checks passed
//   1   one or more checks failed
//   2   dev server unreachable (no checks could run)

const args = process.argv.slice(2)
const urlIdx = args.indexOf('--url')
const BASE = urlIdx >= 0 && args[urlIdx + 1] ? args[urlIdx + 1] : 'http://localhost:3000'

const C = {
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  reset: '\x1b[0m',
}

let passed = 0
let failed = 0
let warned = 0
const failures = []

function ok(name, detail) {
  passed++
  console.log(`${C.green}✓${C.reset} ${name}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`)
}
function ko(name, detail) {
  failed++
  failures.push(name)
  console.log(`${C.red}✗${C.reset} ${name}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`)
}
function warn(name, detail) {
  warned++
  console.log(`${C.yellow}~${C.reset} ${name}${detail ? `  ${C.dim}${detail}${C.reset}` : ''}`)
}
function section(title) {
  console.log(`\n${C.bold}${title}${C.reset}`)
}

async function preflight() {
  section('Preflight')
  try {
    const res = await fetch(BASE, { method: 'HEAD', redirect: 'manual' })
    if (res.status >= 200 && res.status < 600) {
      ok('Dev server reachable', `${BASE} → ${res.status}`)
      return true
    }
    ko('Dev server reachable', `unexpected status ${res.status}`)
    return false
  } catch (err) {
    ko('Dev server reachable', `${BASE} → ${(err && err.message) || err}`)
    console.log(`\n${C.yellow}Start it with:${C.reset}  pnpm run dev`)
    return false
  }
}

async function checkRoute(path, { expectStatus = 200, expectBody, name } = {}) {
  const label = name ?? `GET ${path}`
  try {
    const res = await fetch(`${BASE}${path}`, { redirect: 'manual' })
    if (res.status !== expectStatus) {
      ko(label, `expected ${expectStatus}, got ${res.status}`)
      return null
    }
    if (expectBody) {
      const text = await res.text()
      if (!expectBody.test(text)) {
        ko(label, `body did not match ${expectBody}`)
        return null
      }
    }
    ok(label, `${res.status}`)
    return res
  } catch (err) {
    ko(label, `${(err && err.message) || err}`)
    return null
  }
}

async function checkHeaders() {
  section('Security headers')
  let res
  try {
    res = await fetch(`${BASE}/`, { redirect: 'manual' })
  } catch (err) {
    ko('Headers fetch', `${(err && err.message) || err}`)
    return
  }
  const want = {
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'strict-transport-security': /max-age=\d{4,}/,
    'permissions-policy': /camera=\(\)/,
    'content-security-policy': /default-src 'self'/,
  }
  for (const [h, expected] of Object.entries(want)) {
    const got = res.headers.get(h)
    if (!got) {
      ko(`Header ${h}`, 'missing')
      continue
    }
    if (expected instanceof RegExp) {
      if (expected.test(got)) ok(`Header ${h}`, got.slice(0, 80))
      else ko(`Header ${h}`, `did not match ${expected}: ${got}`)
    } else {
      if (got.toLowerCase() === expected.toLowerCase()) ok(`Header ${h}`, got)
      else ko(`Header ${h}`, `expected "${expected}", got "${got}"`)
    }
  }
}

async function checkPublicRoutes() {
  section('Public routes')
  await checkRoute('/')
  await checkRoute('/login')
  await checkRoute('/register')
  await checkRoute('/accept-invite/this-token-does-not-exist', {
    name: 'GET /accept-invite/<garbage>',
  })
}

async function checkAuthProxy() {
  section('Better Auth proxy')
  await checkRoute('/api/auth/ok', {
    name: 'GET /api/auth/ok',
    expectBody: /"ok":\s*true/,
  })
  await checkRoute('/api/auth/get-session', {
    name: 'GET /api/auth/get-session (anonymous)',
  })

  // Confirm sign-up route is wired (rejects bad payload with 4xx, not 404)
  try {
    const res = await fetch(`${BASE}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: '', password: '', name: '' }),
    })
    if (res.status === 404) {
      ko('POST /api/auth/sign-up/email reachable', '404 — proxy not wired')
    } else if (res.status >= 400 && res.status < 500) {
      ok(
        'POST /api/auth/sign-up/email reachable',
        `${res.status} (rejected invalid payload)`,
      )
    } else {
      warn(
        'POST /api/auth/sign-up/email reachable',
        `unexpected ${res.status} — investigate`,
      )
    }
  } catch (err) {
    ko('POST /api/auth/sign-up/email reachable', `${(err && err.message) || err}`)
  }
}

async function checkProtectedRoutes() {
  section('Protected routes (anonymous)')
  // /app SSR returns 200 then client-side redirects to /login.
  // We just verify the route exists and doesn't 5xx.
  const res = await checkRoute('/app', { name: 'GET /app (SSR)' })
  if (res) {
    const text = await res.text()
    if (text.includes('Loading') || text.includes('login')) {
      ok('/app SSR carries client-redirect hint', '')
    } else {
      warn('/app SSR content', 'no "Loading" / "login" string — verify manually')
    }
  }
}

async function checkHtmlShape() {
  section('HTML shape')
  let html
  try {
    const res = await fetch(`${BASE}/`)
    html = await res.text()
  } catch (err) {
    ko('Fetch / for HTML inspection', `${(err && err.message) || err}`)
    return
  }
  const checks = [
    { name: 'has <!doctype html>', re: /<!doctype html/i },
    { name: 'has <head>',          re: /<head[\s>]/ },
    { name: 'has Tailwind/inline CSS link', re: /<link[^>]+stylesheet/i },
    {
      name: 'has TanStack client script',
      re: /tanstack-start-client-entry|tsr-stream-barrier|<script[^>]+src=/i,
    },
    { name: 'no React error boundary text', re: /^(?!.*(Application error|Internal Server Error)).*/s },
  ]
  for (const c of checks) {
    if (c.re.test(html)) ok(c.name)
    else ko(c.name)
  }
}

async function checkEnv() {
  section('Environment hints (best-effort)')
  // The script can't read Convex env directly; we look at side-effects.
  // AI chat needs ANTHROPIC_API_KEY — if absent, /api/chat returns 500
  // on an authed request. We can't auth from here, so this is informational.
  warn(
    'ANTHROPIC_API_KEY',
    'run `pnpm exec convex env list` to confirm before testing AI chat',
  )
  warn(
    'RESEND_API_KEY + RESEND_TEST_MODE=false',
    'required for real invitation / magic-link / change-email / delete-account emails',
  )
  warn(
    'BETTER_AUTH_SECRET + SITE_URL',
    'required for sessions and absolute URLs in emails',
  )
}

async function main() {
  console.log(`${C.bold}albo-ouvre-boite smoke tests${C.reset}  ${C.dim}${BASE}${C.reset}`)
  const up = await preflight()
  if (!up) process.exit(2)

  await checkHeaders()
  await checkPublicRoutes()
  await checkAuthProxy()
  await checkProtectedRoutes()
  await checkHtmlShape()
  await checkEnv()

  console.log(`\n${C.bold}Summary${C.reset}`)
  console.log(`  ${C.green}${passed} passed${C.reset}`)
  if (failed > 0) console.log(`  ${C.red}${failed} failed${C.reset}`)
  if (warned > 0) console.log(`  ${C.yellow}${warned} warnings${C.reset}`)

  if (failed > 0) {
    console.log(`\n${C.red}Failed checks:${C.reset}`)
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  console.log(`\n${C.green}All checks passed.${C.reset}`)
  console.log(`${C.dim}Manual tests next: auth flow, invitations, items CRUD, AI chat, settings, super-admin.${C.reset}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
