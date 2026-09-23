#!/usr/bin/env node
/**
 * Provision a Convex production deployment for this template.
 *
 * Usage:
 *   node scripts/setup-prod.mjs
 *
 * What it does:
 *   1. Prompts for your prod domain (e.g. https://app.example.com).
 *   2. Reads your dev Convex env vars (`convex env list`).
 *   3. Prompts for the prod object store (bucket + credentials), which are
 *      never mirrored: a prod bucket reachable with the dev key is not a
 *      separate environment.
 *   4. Mirrors what is safe to share (RESEND_*, MISTRAL_API_KEY, the object
 *      store endpoint/region, optional SENTRY_DSN and Google OAuth), sets
 *      APP_ENV=production and SITE_URL to the chosen domain,
 *      forces RESEND_TEST_MODE=false, and generates a FRESH
 *      BETTER_AUTH_SECRET and PURGE_HASH_SALT.
 *   5. Asks for confirmation, then runs `convex env set --prod` for each
 *      and `convex deploy` to push the backend.
 *
 * What it does NOT do:
 *   - Touch the web host. The front end lives on Vercel: one project per
 *     environment (staging, production), each with DEPLOY_CONVEX,
 *     CONVEX_DEPLOY_KEY, VITE_CONVEX_SITE_URL and MEDIA_ORIGIN. See
 *     README.md "Deploying: staging and production".
 *   - Set RESEND_WEBHOOK_SECRET. Each Resend webhook has its own secret, so
 *     there is nothing to mirror — create the prod webhook and set it by hand.
 *   - Configure CORS on the prod bucket. Without it every candidate upload
 *     fails at the preflight; see TESTING.md P2.
 *
 * Why fresh BETTER_AUTH_SECRET: reusing the dev secret in prod means a
 * dev session token would also unlock prod (and vice versa). Same reasoning
 * for PURGE_HASH_SALT: a shared salt makes the two erasure registers
 * comparable, which is exactly what hashing the address is meant to prevent.
 */

import { execSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import readline from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

const rl = readline.createInterface({ input, output })
const ask = (q) => rl.question(q)

function listDevEnv() {
  try {
    const raw = execSync('pnpm exec convex env list', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const map = new Map()
    for (const line of raw.split('\n')) {
      const idx = line.indexOf('=')
      if (idx === -1) continue
      map.set(line.slice(0, idx).trim(), line.slice(idx + 1))
    }
    return map
  } catch (e) {
    console.error(
      '\n❌ Could not read dev env. Run `pnpm exec convex dev` once first ' +
        'to provision the dev deployment, then re-run this script.\n',
    )
    process.exit(1)
  }
}

function setProdEnv(key, value) {
  const r = spawnSync(
    'pnpm',
    ['exec', 'convex', 'env', 'set', '--prod', key, value],
    { stdio: 'inherit' },
  )
  if (r.status !== 0) {
    console.error(`❌ Failed to set ${key} on prod`)
    process.exit(1)
  }
}

async function main() {
  console.log('\n  Convex prod setup\n')

  // `convex env set --prod` IGNORES --prod when a deploy key is present: it
  // writes to whatever deployment the key points at. In a dev shell (or a
  // cloud sandbox, where the key is injected) this script would silently
  // provision DEV as if it were prod — production SITE_URL, a rotated
  // BETTER_AUTH_SECRET, the lot. Refuse rather than guess.
  if (process.env.CONVEX_DEPLOY_KEY) {
    console.error(
      '❌ CONVEX_DEPLOY_KEY is set in this shell.\n' +
        '   `--prod` is ignored when a deploy key is present, so this script\n' +
        '   would write to the deployment that key points at — probably dev.\n' +
        '   Re-run without it:  env -u CONVEX_DEPLOY_KEY pnpm setup:prod\n',
    )
    process.exit(1)
  }

  const domain = (
    await ask('Prod domain (e.g. https://app.example.com): ')
  ).trim()
  if (!/^https:\/\/[^\s/]+$/.test(domain)) {
    console.error('❌ Must be a full `https://...` URL with no trailing slash.')
    process.exit(1)
  }

  console.log('\n  Reading dev env vars…')
  const dev = listDevEnv()

  const missing = [
    'RESEND_API_KEY',
    'RESEND_FROM',
    'MISTRAL_API_KEY',
    'OBJECT_STORE_ENDPOINT',
    'OBJECT_STORE_REGION',
  ].filter((k) => !dev.get(k))
  if (missing.length) {
    console.error(
      `\n❌ Missing on dev: ${missing.join(', ')}.\n` +
        'Set them on dev first (so this script can mirror them), e.g.:\n' +
        '  pnpm exec convex env set RESEND_API_KEY re_...\n',
    )
    process.exit(1)
  }

  // The object store is the one thing that must NOT be mirrored: a prod
  // bucket the dev key can open is not a separate environment. Ask, and
  // refuse anything that matches dev.
  console.log(
    '\n  Prod object store (the dev values are never reused — a prod bucket\n' +
      '  reachable with the dev key would defeat the separation):\n',
  )
  const bucket = (await ask('  Prod bucket name: ')).trim()
  const accessKeyId = (await ask('  Prod access key id: ')).trim()
  const secretAccessKey = (await ask('  Prod secret access key: ')).trim()

  const clashes = [
    ['OBJECT_STORE_BUCKET', bucket],
    ['OBJECT_STORE_ACCESS_KEY_ID', accessKeyId],
    ['OBJECT_STORE_SECRET_ACCESS_KEY', secretAccessKey],
  ].filter(([k, v]) => !v || v === dev.get(k))
  if (clashes.length) {
    console.error(
      `\n❌ Empty, or identical to dev: ${clashes.map(([k]) => k).join(', ')}.\n` +
        '   Create a separate bucket and a separate Scaleway application for\n' +
        '   prod, then re-run.\n',
    )
    process.exit(1)
  }

  const plan = {
    APP_ENV: 'production',
    SITE_URL: domain,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    PURGE_HASH_SALT: randomBytes(32).toString('hex'),
    RESEND_API_KEY: dev.get('RESEND_API_KEY'),
    RESEND_FROM: dev.get('RESEND_FROM'),
    RESEND_TEST_MODE: 'false',
    MISTRAL_API_KEY: dev.get('MISTRAL_API_KEY'),
    OBJECT_STORE_ENDPOINT: dev.get('OBJECT_STORE_ENDPOINT'),
    OBJECT_STORE_REGION: dev.get('OBJECT_STORE_REGION'),
    OBJECT_STORE_BUCKET: bucket,
    OBJECT_STORE_ACCESS_KEY_ID: accessKeyId,
    OBJECT_STORE_SECRET_ACCESS_KEY: secretAccessKey,
  }
  for (const k of ['SENTRY_DSN', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']) {
    const v = dev.get(k)
    if (v) plan[k] = v
  }
  const googleMirrored = !!plan.GOOGLE_CLIENT_ID

  console.log('\n  Will set on prod:')
  for (const [k, v] of Object.entries(plan)) {
    const sensitive =
      k.includes('SECRET') || k.includes('KEY') || k.includes('TOKEN')
    console.log(`    ${k} = ${sensitive ? '<redacted>' : v}`)
  }

  const ok = (await ask('\nProceed? [y/N] ')).trim().toLowerCase()
  if (ok !== 'y' && ok !== 'yes') {
    console.log('Aborted.')
    rl.close()
    return
  }
  rl.close()

  console.log('\n  Setting env vars on prod…')
  for (const [k, v] of Object.entries(plan)) {
    setProdEnv(k, v)
  }

  console.log('\n  Deploying Convex prod (re-deploys functions with new env)…')
  const dep = spawnSync('pnpm', ['exec', 'convex', 'deploy'], {
    stdio: 'inherit',
  })
  if (dep.status !== 0) {
    console.error('❌ `convex deploy` failed — fix the error above and re-run.')
    process.exit(1)
  }

  console.log(`
  ✅ Convex prod is provisioned.

  Next (frontend on Vercel) — see README.md "Deploying: staging and production".
  One Vercel project per environment. On its Production scope, set:

    DEPLOY_CONVEX         true
    CONVEX_DEPLOY_KEY     <prod deploy key from the Convex dashboard>
    VITE_CONVEX_SITE_URL  https://<prod-deployment>.convex.site
    MEDIA_ORIGIN          https://<prod-bucket>.s3.<region>.scw.cloud

  VITE_CONVEX_SITE_URL must point at the PROD deployment (the dashboard URL
  with .site instead of .cloud), NOT your dev one. VITE_CONVEX_URL is not set
  by hand on Production: convex deploy --cmd injects it into the build.

  Its production branch is main (staging) or production (prod), and its
  ignored build step skips every other branch: no preview builds.

  Then test a magic link from ${domain}. The link should point at
  ${domain}/api/auth/magic-link/verify (not localhost).
`)

  if (googleMirrored) {
    console.log(`  ⚠️  Google OAuth was mirrored to prod. In Google Cloud Console,
      on the SAME OAuth client you use for dev, add these alongside the
      existing localhost entries:

        Authorized redirect URI:  ${domain}/api/auth/callback/google
        Authorized JS origin:     ${domain}

      Until both prod URIs are registered, Google sign-in returns
      redirect_uri_mismatch.
`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
