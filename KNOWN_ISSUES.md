# Known issues

Pinned versions, workarounds, and rough edges. Update this file as upstream
fixes land so renovate (which respects `pnpm.overrides`) can be unblocked.

## Account linking & verified email (anti-doublon)

### What went wrong (the trap)

Initial config in `convex/auth.ts` had:
- `emailAndPassword.requireEmailVerification: false` — password sign-up
  produced an **untrusted** BA account (BA can't confirm the user owns
  the mailbox).
- `magicLink` plugin — produced a **trusted** account on first click.
- **No `account.accountLinking`** — BA's default is `enabled: false`.

When a single human signed up via `/register` (password) then later
clicked a magic link with the same email, BA created **two distinct BA
users** (different `betterAuthId`). Our `provisionAppUser` then inserted
**two `users` rows** into Convex with the same email, because it
dedup'd only by `betterAuthId`.

Result : prod had two duplicate `users` rows for one human.

### The rule (preventing recurrence)

**Before adding or modifying any auth method in `convex/auth.ts`**, check
all three :

1. **All enabled methods must be trusted.** A method is trusted when BA
   marks `emailVerified: true` after the first sign-in. Sources of
   trust : magic link, OAuth (Google/GitHub/…), or email/password with
   `requireEmailVerification: true`. **Never enable email/password with
   verification off if any other method is enabled.**
2. **`account.accountLinking.enabled: true` in `createAuth(...)`.**
   Without it, two trusted methods with the same email still produce
   two BA users. With it, BA auto-links on the second sign-in.
3. **Convex-side dedup**: `provisionAppUser` in `convex/lib/auth.ts`
   already falls back from `betterAuthId` lookup to email lookup, and
   re-points the existing row's `betterAuthId` instead of inserting.
   If you ever write a new "create app user" code path, copy that
   pattern — don't dedup on `betterAuthId` alone.
4. **Magic link must not auto-sign-up**:
   `magicLink({ disableSignUp: true })` is mandatory. Our only legit
   entry point is `/register` (password + verification). Without it,
   any random email gets a verified BA account on first link click,
   bypassing the `/register` flow and leaving password-less accounts
   that later 500 on `signIn.email`.

### Security coupling

Conditions (1) and (2) are coupled. If you enable account linking but
let one method stay untrusted, an attacker can register
`victim@example.com` with their own password (no verification needed),
wait for the victim to OAuth/magic-link with the same email, and BA
will silently link the attacker's password account to the victim's
session → account takeover.

Verified email closes the hole : the attacker's password account stays
unverified, so BA refuses to link it.

### Legacy users

Prod accounts created before this fix have `emailVerified: false` on the BA
side. On the next `signIn.email`, they will be blocked — the `/login` screen
detects `EMAIL_NOT_VERIFIED` and offers "Resend verification email" to
unblock. No automatic migration.

For duplicate `users` rows already created in prod, `provisionAppUser` will
converge them to a single row on the user's next login, but the second BA
user remains in the database. Manual cleanup via the Convex dashboard.

## Invitation signup — token-gated email pre-verification

### The problem

`emailAndPassword.requireEmailVerification: true` sends every signup through
a verification email. For an **invited** user that round-trip is both
redundant and broken: the accept logic lives in a `useEffect` on
`/accept-invite/$token`, so after clicking the verification link the invitee
is signed in but lands wherever the callback points — not necessarily back on
the accept page — and the invitation is never accepted.

### The fix (and why token-gated, NOT email-gated)

`convex/auth.ts` adds `databaseHooks.user.create.before`. It reads
`inviteToken` from the signup body (`context.body`) and, **only** when that
token resolves to a still-pending, unexpired invitation **for the same
email** (via the `internal.invitations.validateInviteForSignup` query →
`isInviteValidForSignup` in `convex/lib/invitations.ts`), returns
`{ data: { ...user, emailVerified: true } }`. Otherwise it touches nothing
and the normal verification flow applies. The front then signs the invitee in
immediately (`signUp` → `signIn` on `/accept-invite`, and `callbackURL` +
`inviteToken` forwarded from `/register`).

**A matching email is never sufficient on its own.** Email-gating (pre-verify
any signup whose address equals some pending invite) was rejected: it would
let an attacker register `victim@example.com` with their own password and get
it marked verified, then — with `accountLinking.enabled: true` — have BA link
that account when the victim later signs in (the takeover hole described in
"Account linking & verified email"). Token-gating closes this: the 32-byte
token is delivered **only** to the invitee's mailbox, so possessing it already
proves mailbox control. Keep the token + email-match check; never relax it to
email alone.

### Gotchas for the next dev

- **`inviteToken` is not in the Better Auth client type.** It's a custom field
  the server forwards via `context.body`, not a declared `user.additionalField`
  (we don't store it). The `/accept-invite` call casts the literal
  (`as Parameters<typeof authClient.signUp.email>[0]`); `/register` sends it
  through a conditional spread that needs no cast. If you add it to
  `additionalFields` it would create a column — don't.
- **Reading the body needs a run context.** The hook uses
  `requireRunMutationCtx(ctx).runQuery(...)` (same pattern as the email
  senders) — `create.before` runs inside the signup mutation, so `runQuery`
  is available. Do **not** annotate the hook's `context` param; let it infer,
  or the heavy `databaseHooks` type can trip the TS inference cycle CLAUDE.md
  flags.
- **`useRedirectWhenAuthenticated` always SPA-navigates to `/app`** (ignores
  `redirect`). Both invite entry points work around this without touching the
  shared guard: `/accept-invite` accepts inline (signUp → signIn → auto-accept
  effect, no navigation), and `/register` in an invite flow does signUp →
  signIn → `window.location.assign('/accept-invite/<token>')` — a **full**
  navigation that wins the race against the guard's SPA `navigate`, handing
  off to the accept page so the invitee is attached to the org instead of
  landing on `/app`. If the token is stale the signIn fails and we fall back
  to the verification screen (`callbackURL` returns to the invite).

## Google OAuth (template — opt-in)

Google social login is wired but **off by default** so the repo stays a clean
template. It activates only when **both** `GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` are set in the Convex env. The `socialProviders` block in
`convex/auth.ts` is spread conditionally on that, and the frontend hides the
button via `api.publicConfig.enabledSocialProviders` (a boolean query — env
presence, never the secret). Pattern: a missing provider must render *nothing*,
not a dead/broken button.

### Enabling it
1. Create an OAuth client in Google Cloud Console → Credentials.
2. **Authorized redirect URI** = `${SITE_URL}/api/auth/callback/google` (the BA
   default; the request flows through the TanStack proxy `src/routes/api/auth/$.ts`
   → Convex handler). Register both the dev (`http://localhost:3000/...`) and the
   prod URL.
3. `pnpm exec convex env set GOOGLE_CLIENT_ID …` / `… GOOGLE_CLIENT_SECRET …`
   (or answer the optional prompt in `pnpm run setup`).
4. **Prod**: `pnpm run setup:prod` mirrors the dev `GOOGLE_*` creds to the prod
   deployment automatically (same OAuth client). The prod redirect URI is *not*
   set for you — add `https://<prod-domain>/api/auth/callback/google` to the same
   Google client by hand (step 2), or sign-in fails with `redirect_uri_mismatch`.

### Why it's safe vs the account-linking trap
Google returns a **verified** email on first sign-in, so it satisfies rule (1)
of "Account linking & verified email" above (all enabled methods trusted). With
`accountLinking.enabled: true` (already set) plus `provisionAppUser`'s email
fallback, a Google sign-in whose email matches an existing password user **links**
to the same Convex `users` row instead of creating a duplicate. No new
provisioning code — the existing `/app` route trigger
(`src/routes/app/route.tsx`) handles it. If you add GitHub/Apple later, the same
trusted-email reasoning applies; flip the scaffold in `linked-accounts.tsx`.

## Auth hardening (Phase 0)

### `sendChangeEmailConfirmation`, not `sendChangeEmailVerification`

The handler that fires on **email-change** lives under
`user.changeEmail.sendChangeEmailConfirmation` in Better Auth (verified
in `node_modules/better-auth/dist/api/routes/update-user.mjs:427`). An
earlier revision used `sendChangeEmailVerification`, which **does not
exist** — BA silently swallowed the callback and only sent the
verification email to the *new* address. A hijacked session could
change the email to attacker@evil.com without the legitimate owner of
the current inbox ever being notified.

Rule: if you rename or relocate the change-email handler, grep BA
source for the exact key BA reads (`ctx.context.options.user.changeEmail.<…>`)
and match it byte-for-byte. The TypeScript types here are permissive
(extra keys are accepted), so a typo compiles but ships broken.

### Anti-enumeration on `/register`

When a signup hits `USER_ALREADY_EXISTS`, the UI renders the *exact
same* "Check your inbox" screen as a successful new signup
(`src/routes/register.tsx`). No verification email is actually sent in
the duplicate case — BA aborts at 422. An attacker can no longer
enumerate registered emails by watching the signup response.

Trade-off : a legit user who signs up twice (e.g. forgot they already
have an account) gets the success screen but no email, then bounces.
The "try a different email" link on that screen and the
`/forgot-password` flow are the recovery paths. Accepted cost for
closing the enumeration leak — same pattern shipped by Linear and
Stripe.

### Cookie attributes are explicit, secure flag is APP_ENV-gated

`convex/auth.ts` pins:

```
advanced: {
  useSecureCookies: APP_ENV === 'production',
  cookiePrefix: 'interw',
  defaultCookieAttributes: { sameSite: 'lax', secure: APP_ENV === 'production', httpOnly: true },
}
```

`secure: true` is required in prod but breaks local dev over plain
`http://localhost` (the cookie is set but the browser refuses to send
it back). The `APP_ENV === 'production'` check keeps localhost working
in dev while forcing the flag everywhere else. If you ever spin up a
staging deploy, set `APP_ENV=production` so the cookie hardening
applies — same trap as the `SITE_URL` guard below.

### Per-endpoint rate-limit storage

BA's built-in `rateLimit` block with `storage: 'database'` is wired
into the Convex adapter — no separate component to install. BA writes
to an auto-created `rateLimit` table on the BA-side schema. We rely
on it for `/sign-in/email`, `/sign-up/email`, `/forgot-password`,
`/reset-password`, `/sign-in/magic-link`, `/email-verification/send`,
`/change-email`, `/change-password`, `/delete-user`.

`convex/rateLimiters.ts` (the `@convex-dev/rate-limiter` component) is
*separate* — it covers application-level limits (invitations, chat,
email-send wrappers). Do not confuse the two : BA's limiter is on the
auth HTTP edge, ours is on Convex mutations/actions.

### Password policy (Phase 1)

- BA: `minPasswordLength: 12`, `maxPasswordLength: 128`.
- Zod schemas in `/register`, `/reset-password`, `/me` mirror the
  minimum. Both layers must agree — if you tighten the Convex side,
  bump the Zod min in the same commit or signup passes client
  validation and 400s on submit.
- HIBP k-anonymity check on every new-password field (`onBlurAsync`
  validator). `src/lib/hibp.ts` soft-fails on network errors so an
  outage at api.pwnedpasswords.com doesn't block signups; the
  server-side minimum still applies.
- zxcvbn-ts strength meter is indicative, not blocking. The wordlist
  is ~1.2 MB but lazy-loaded only when a password field mounts.

### eslint must be a direct devDependency

`eslint.config.mjs` does `import { defineConfig } from 'eslint/config'`,
which requires `eslint` to be resolvable from the project root. pnpm
10's strict isolation does not hoist transitive devDeps, so without
`"eslint": "^10"` in `devDependencies` the lint script fails with
`Cannot find package 'eslint'`.

This was silently broken before Phase 1 (the `| tail -40` wrapper in
the lint script swallowed the failing exit code). Adding `eslint` to
`devDependencies` fixes the run; it also surfaces ~240 pre-existing
lint errors (`sort-imports`, `import/order`, `@typescript-eslint/array-type`)
across non-auth routes that pre-date Phase 0/1 and want a separate
cleanup PR. The new Phase 1 files (`hibp.ts`, `auth-errors.ts`,
`password-input.tsx`, `password-strength.tsx`) lint clean.

## The template's HTTP headers denied the camera, and muted every video

`src/start.ts` sets the security headers on every response. Two of them came
from the template — written for an app with no camera and no media — and were
never revisited when the product grew both. They shipped for a whole build.

**`Permissions-Policy: camera=(), microphone=()`.** An empty allowlist `()`
means *no origin at all, `self` included*: it denies the capability to the
document that sent the header. Every `getUserMedia` call in the product
(`src/routes/s/$token/interview.tsx`, `src/routes/s/$token/check.tsx`,
`src/components/projects/MediaRecorderField.tsx`) fails with
`NotAllowedError` on Chrome and Edge — and `check.tsx` reads that error as
"the candidate refused permission" and tells them to click a browser icon
that is not there. The value that grants the capability to the app and to
nobody else is `camera=(self), microphone=(self)`.

**A CSP with no `media-src`.** Missing, it falls back to `default-src 'self'`,
which blocks every `<video src="https://….scw.cloud/…">`: recruiter question
media, the candidate's answers on the review screen, and the shared report all
play nothing, with no error the user can see. `blob:` belongs in the directive
too — local previews are object URLs, not bucket URLs.

**The aggravating part**: `scripts/e2e-smoke.mjs` *asserted* `camera=()`. The
only automated check that touched these headers was holding the bug in place.
An assertion that encodes what the code currently emits is not a check; it has
to encode what the product needs.

The headers now live in `src/lib/security-headers.ts` as data, with
`src/lib/security-headers.test.ts` over them, because two strings that decide
whether the product works at all should not be reachable only by booting a
browser.

### `MEDIA_ORIGIN` is a web-server variable, not a Convex one

Every other object-store setting (`OBJECT_STORE_*`) lives on the Convex
deployment, which is where signed URLs are minted. But the CSP is served by
the TanStack Start server, which never talks to the bucket and therefore knows
nothing about it. Hence one deliberately duplicated setting: `MEDIA_ORIGIN`
(e.g. `https://interw-media.s3.fr-par.scw.cloud`) on the **web server**
environment — Vercel project settings, or `.env.local` for `pnpm dev`. Unset,
`media-src` falls back to `https:`, so a deployment that has not wired it
plays video instead of failing silently; set, it pins playback to the one host
it should ever come from. It is read inside the middleware's server handler,
never at module scope — `src/start.ts` is the isomorphic Start entry, and
`process` does not exist in the browser.

## A return-URL search param needs the URL parser, not a regex

`/login` takes `?redirect=` and, after a successful `signIn.email`, calls
`window.location.replace(redirect)`. The param was typed `z.string().optional()`,
so `/login?redirect=https://evil.com` was an **open redirect**: the victim signs
in on our real domain with real credentials and gets handed to the attacker at
the exact moment they have proven they trust the page. Better Auth was no help
here — `signIn.email` never receives a `callbackURL`, so BA's `trustedOrigins`
check (`convex/auth.ts`) never runs. Only the redirects *we* navigate to
ourselves are exposed.

Fixed by `src/lib/safe-redirect.ts`, applied in `/login` and `/register`.

**The trap, and why the obvious fix is wrong.** The tempting predicate is
"starts with `/` but not `//`":

```ts
const isInternalPath = (v: string) => /^\/(?![/\\])/.test(v)   // ← BYPASSABLE
```

It passes `/\t/evil.com` (slash, TAB, slash). Per the WHATWG URL spec browsers
**strip** ASCII tab, LF and CR while parsing, so that string becomes
`//evil.com` — protocol-relative, off-site — after passing a check that read the
raw bytes. Demonstrated:

```
new URL('/\t/evil.com', 'https://ourapp.com').origin   // → 'https://evil.com'
```

So validate by resolving against a throwaway origin and requiring the result to
stay on it. That delegates normalisation to the same parser the navigation will
use, instead of trying to out-guess it:

```ts
new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN && value.startsWith('/')
```

`startsWith('/')` is still needed — a bare `app` resolves onto the probe origin
but is not a rooted path. An encoded slash (`/%2f%2fevil.com`) is *kept* and is
safe: browsers resolve it as a path on the current origin, never as a new host.

Two design notes:

- The Zod field ends in `.catch(undefined)`, so a hostile value collapses to
  "no redirect" and the page renders normally. Throwing would surface an error
  screen that advertises the attempt.
- **Nothing in this app produces `?redirect=`.** Every navigation to `/login`
  and `/register` is bare, and the invitation email links straight to
  `${siteUrl}/accept-invite/${token}`. The param is externally supplied and only
  ever *propagated* between the login↔register cross-links. So the guard cannot
  regress a legitimate flow — but it also means the return-URL is not preserved
  when the `/app` guard bounces you to `/login` (a UX gap, not a security one).

## Deploys are wired into the Vercel build

One Vercel project per environment (setup and env vars: README § "Deploying:
staging and production"). Vercel installs with the pnpm named in
`packageManager`, then runs the `build` script, which branches on
`DEPLOY_CONVEX`:

```
DEPLOY_CONVEX=true  →  npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL \
                                          --cmd 'pnpm build:app'
otherwise           →  pnpm build:app          (vite build && tsc --noEmit)
```

So every push to an environment's branch **also** deploys Convex functions
and schema in lockstep. You should never run `pnpm exec convex deploy --prod`
by hand for a normal release — the Vercel deployment is the source of truth.

`VITE_CONVEX_URL` is deliberately **absent** from the README's env table: `convex deploy`
injects it into the `--cmd` sub-process itself, which is what
`--cmd-url-env-var-name` names. Setting it by hand on the project would shadow
the value the CLI just resolved.

**Why the guard is one condition, not two.** An earlier script also required
`$CONVEX_DEPLOY_KEY` and fell back to a plain build without it — which shipped
a frontend against an un-deployed backend and said so in a log line nobody
reads. Now `DEPLOY_CONVEX=true` alone arms it, and a missing or invalid key
fails `convex deploy`, so the deployment goes red instead of drifting
quietly. It is host-neutral on purpose, not keyed off `$VERCEL`.

### Vercel previews must never carry a deploy key

Each project's **Ignored Build Step** (README step 2) skips every branch but
its own, so a pull request builds nothing. That is deliberate:

- A preview build scoped with the production `CONVEX_DEPLOY_KEY` would push
  the branch's functions and schema at that environment's backend — a schema
  change on a draft PR is enough to take it down. Convex refuses the pairing
  (§ "Convex refuses a production deploy key in a Vercel preview build"),
  but only because `VERCEL_ENV` says `preview`; the key
  staying out of the Preview scope is what actually keeps it safe.
- A preview **without** a deploy key builds a frontend against the current
  backend — fine for UI-only work, silently wrong for a PR that depends on
  un-deployed schema.
- Per-branch Convex backends need a *preview* deploy key, `preview` env
  defaults, and a `trustedOrigins` that accepts branch URLs — see § "A
  preview deployment starts with no environment variables". None of it is wired.

Previews stay off until that last point is wired.

**When you DO need the manual command**:

- Local dev (`pnpm exec convex dev` — different command, runs the dev
  deployment with hot reload).
- Emergency hotfix where the host is broken: `pnpm exec convex deploy --prod`
  works but is a footgun (frontend still pointing at old code). Prefer
  moving the environment's branch back to a good commit and letting the
  platform redeploy.

### Node version is not pinned the way pnpm is

`engines.node` is `">=22"`, a range, not a pin. CI runs Node 22; Vercel
reads the range, overrides the project's own "22.x" setting, and builds on
the latest major it offers (24 today — the build log warns about it). That
divergence has been harmless so far, and the range is deliberate (this
template is forked). If a build ever fails on the platform but passes in CI,
check the Node major in the build log first, and pin `engines.node` to a
single major in one deliberate PR rather than guessing at the symptom.

## pnpm.overrides

These live in the `pnpm.overrides` field of `package.json`, and **must stay
there** — see "pnpm 11 silently drops them" below. Renovate is configured to
leave all four alone (`renovate.json`, rule "Pinned overrides"), so they only
ever move by hand.

### `@tanstack/react-router: 1.170.11` + `@tanstack/router-core: 1.171.9`

Two router-core versions coexisting (one pulled by `react-router`, one by
`start-client-core`) prevented `server.handlers` from being type-augmented
on `createFileRoute`. Pinning both to compatible versions resolves it.

**Unblock when**: TanStack publishes a release where `react-router` and
`react-start` agree on a single `router-core` version.

### `@tanstack/react-start: 1.168.20`

Pinned in lockstep with the router pin above.

### `better-call: 1.3.4` — LIFTED 2026-08-24, kept as the cautionary tale

`better-call@1.3.5` originally shipped without `openapi.mjs` and
`validator.mjs`, breaking Better Auth's runtime imports, so it was pinned to
the last working release. Upstream fixed that in the 1.3.5 tarball, and the
pin was **removed on 2026-08-24**. `better-call` now resolves to whatever
Better Auth asks for (1.4.0 today) — there is no override left to maintain.

Why it is still written down: this pin outlived its reason by four days of
documented "unblock condition met, lift it deliberately", and in the meantime
the Better Auth bump to 1.6.30 quietly widened it from one patch back to two
minors back. **A pin with an expired unblock condition is not neutral — it
drifts from a small lie into a big one while nobody is looking.** When you add
an override, write its exit condition next to it, and re-read that condition
every time you touch the package it constrains.

Removal was verified, not assumed: cold `pnpm install` resolves a single
`better-call@1.4.0`, then `pnpm lint`, `pnpm build` and `pnpm test:smoke`
(21/21) all pass, and a live `POST /api/auth/sign-in/magic-link` reaches
`sendMagicLink` through it.

## pnpm 11 silently drops `pnpm.overrides` and `onlyBuiltDependencies`

**The pin in `package.json` (`packageManager: pnpm@10.34.5+sha512...`) is load
bearing. Do not remove it, and do not "modernise" it to pnpm 11 casually.**

pnpm 11 made two breaking config moves. Both fail *silently* or with an error
that names the wrong culprit:

1. **`pnpm.overrides` in `package.json` is no longer read.** pnpm 11 emits a
   single `[WARN]` line and carries on. Observed effect: `better-call` drifted
   1.3.4 → 1.3.5 and the `@tanstack/router-core` override was replaced by the
   loose peer range `>=1.114.7` — i.e. every pin documented above quietly
   stopped applying, while `renovate.json` still believed it was guarding them.
2. **`onlyBuiltDependencies` was removed** in favour of `allowBuilds` (a
   name → boolean map). pnpm 11 writes a placeholder into `pnpm-workspace.yaml`
   (`esbuild: set this to true or false`), which is not a boolean, so builds
   stay unapproved — and pnpm 11 **exits 1** where pnpm 10 only warned. Since
   pnpm runs a dependency check before every script, `pnpm typecheck`,
   `pnpm lint`, `pnpm build` and `pnpm dev` all die with
   `ERR_PNPM_IGNORED_BUILDS` before running a single byte of project code.

Third-order effect: a pnpm 11 install rewrites `pnpm-lock.yaml` (~428 lines,
`overrides:` block dropped). Commit that and CI fails with
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`; regenerate it under pnpm 10 and the next
local install rewrites it again. Permanent ping-pong, and the diff is large
enough to hide a real change.

**Why we stay on pnpm 10 rather than migrating.** Migrating is technically
clean — moving `overrides` into `pnpm-workspace.yaml` and using `allowBuilds`
produces a byte-identical lockfile, verified. We don't, because of the
deployment target:

- **The host has to resolve the pinned pnpm.** Vercel reads the
  `packageManager` pin with no Corepack opt-in (the build log names the pnpm
  it picked; neither project sets `ENABLE_EXPERIMENTAL_COREPACK`).
  That does not by itself clear pnpm 11, which still has to be confirmed as
  resolvable on the platform before anyone bumps.
- **`overrides` must stay in `package.json`.** Settings in
  `pnpm-workspace.yaml` are a pnpm 10+ feature, so any host that resolves our
  `lockfileVersion: 9.0` to pnpm 9 ignores overrides declared in the workspace
  file **in production only**. Keeping them in `package.json` is understood by
  9, 10 and (with the pin) is never reached by 11.

**How the pin is enforced**, three layers deep:

- `packageManager` + the sha512 integrity hash — Corepack downloads exactly
  this build. Written with `corepack use pnpm@<version>`, never by hand.
- `engines.pnpm: "10.x"` — catches anyone running pnpm with Corepack disabled.
- CI passes no `version:` to `pnpm/action-setup@v4`, so it reads
  `packageManager` too. **Never re-pin a version there** — that is what let
  local and CI diverge in the first place.

Belt and braces confirmed: invoking pnpm 11 anyway now hard-fails with
`This project is configured to use 10.34.5 of pnpm. Your current pnpm is
v11.22.0` instead of quietly mangling the lockfile.

**Unblock when**: the deployment target is confirmed to resolve pnpm 11 from
`packageManager`. Then, in one deliberate PR: bump `packageManager`, move `pnpm.overrides` →
`overrides:` in `pnpm-workspace.yaml`, replace `onlyBuiltDependencies` with
`allowBuilds: {esbuild: true, unrs-resolver: true}`, and confirm
`pnpm install --frozen-lockfile` leaves the lockfile untouched.

## `node_modules` is not as big as `du` says

`du -sh node_modules` reports ~617 MB. Deleting it frees **~25 MB**, and
reinstalling costs ~25 MB and 3 seconds. Both directions measured with `df`.

pnpm's default `package-import-method=auto` uses APFS `clonefile()`, so every
file is a copy-on-write clone of the shared store (`~/Library/pnpm/store/v11`,
~922 MB, paid once per machine). `du` walks each file and adds up allocated
blocks with no idea they are shared, so it counts the same physical extents
once per worktree. Verified at the block level: the same file in two Conductor
worktrees reports an identical `F_LOG2PHYS` device offset with `nlink=1` —
distinct inodes, one set of blocks. 99.9 % of sampled bytes are shared.

Consequence: 11 worktrees cost ~275 MB, not ~6.8 GB. **Do not** "optimise"
this by setting `node-linker=hoisted`, pointing `package-import-method` at
`copy`, or hand-rolling a shared `node_modules` — each of those turns clones
back into real bytes. The one thing that would break it is moving the pnpm
store off the workspace volume: `clonefile()` cannot cross volumes, and the
275 MB would become 6.8 GB overnight.

## Convex skills were pruned — do not re-vendor them

We vendored 6 Convex skills. **5 were removed; only `convex-create-component`
remains.** If a future agent notices "there's no Convex auth skill" and tries
to add one back, read this first.

### What happened upstream

`get-convex/agent-skills` stopped being a hand-maintained library and became a
**generated export surface** of a private hub (`get-convex/convex-agents`).
Their own PR says it plainly:

> Makes this repo a **generated surface** of the convex-agents hub: 35
> SKILL.md files (one per public capability), **replacing the hand-maintained
> 6-skill subset**. This is the surface to hand Vercel for v0 / skills.sh.

And the acceptance test for that rewrite was **activation**, not content:

> Activation among v0-style distractor skills (vercel-deploy, shadcn-ui,
> stripe, playwright, tailwind, seo): 13/13 […] Routing to the correct
> bundled skill: 12/12.

Once the metric is "does my skill win the routing coin-flip against `stripe`
in v0", the `description` becomes a sales pitch (the follow-up PR is literally
titled *"Main skill: sell Convex to agents"*) and the body stops mattering.
Three of our six were then deleted outright as "non-production".

### Why we did not follow

Measured, not assumed — vendored bytes vs everything upstream offers today
(new `SKILL.md` + its served catalog doc combined):

| capability | vendored (pinned `ec1e6ba`) | upstream today | |
| ---------- | --------------------------- | -------------- | --- |
| auth       | 36 567 B across 7 files     | 3 920 B        | −89 % |
| migrate    | 18 147 B across 5 files     | 1 812 B        | −90 % |
| optimize   | 41 947 B across 7 files     | 3 229 B        | −92 % |

The content did **not** move server-side — that was worth checking, and it is
false. The served docs (`https://basic-anteater-667.convex.site/capability/
<id>.md`) are *smaller* than the stubs. It was deleted.

Two further disqualifiers for this repo specifically:

- The new `convex-auth` documents **`@convex-dev/auth` with passkeys**. We use
  **Better Auth** (`@convex-dev/better-auth`). The part of the old skill that
  was useful here — the provider comparison (Clerk, Auth0, WorkOS, Convex
  Auth) — is exactly the part that was cut.
- The new main skill instructs the agent to **fetch and follow remote
  procedure docs at runtime**, "prefer the served copy: it is newer", and
  mentions `tier>0` capabilities that **spend money**. That structurally
  defeats `pinnedRef` + `computedHash` + `--verify`: the hash covers the
  pointer, never what it fetches.

### Why we deleted rather than froze

Freezing at `ec1e6ba` would have kept the depth, but frozen docs rot, and the
rot would be invisible. Deleting is safe because **the vendored skills were
never the freshness channel** — see `CLAUDE.md`, "Convex knowledge comes from
three self-refreshing channels". `guidelines.md` is regenerated by
`convex dev` and outranks skills by our own rule; the Convex MCP reads the
live deployment and cannot go stale.

And each deleted skill was already dead weight here:

- `convex` — a router whose only job was pointing at the five below. Broken by
  construction once they go.
- `convex-quickstart` — bootstraps a new Convex app. This app exists. A
  genuinely new project would use `npm create convex@latest` +
  `npx convex ai-files install`, or fork this template via `pnpm run init`.
- `convex-setup-auth` — see above, wrong auth product.
- `convex-migration-helper`, `convex-performance-audit` — the only real loss.
  Both answer questions the **MCP answers better**, by reading your actual
  tables and logs instead of describing the general case.

`convex-create-component` survives because upstream explicitly **exempted it
from the generator** ("no generated counterpart […] kept untouched"). It is
the last hand-written one, so it is the last deep one.

### If you genuinely need migration or perf depth again

Do not re-vendor from `get-convex/agent-skills` — it will hand you a 1 KB
stub. Either use the Convex MCP against the live deployment, or write the
procedure into this repo as **our own** content that we own and update.

## Better Auth is boxed into `>=1.6.22 <1.7.0`

Two lines in `package.json` look over-specified and are not. Don't "tidy"
either operator:

```json
"@convex-dev/better-auth": "0.12.2",   // exact — NOT a range
"better-auth": "~1.6.30",              // tilde — NOT a caret
```

### The floor: GHSA-qq9h-g4jm-xgf3

High severity, *"Account takeover via pre-account hijacking on magic-link and
email-OTP sign-in"*. Vulnerable `>= 1.1.3, < 1.6.22`; fixed in **1.6.22**.
`convex/auth.ts` loads `magicLink()`, so this repo sits squarely in the blast
radius — and because it is a template, every project forked from it is born
with whatever the lockfile carries. That is why this floor is a lockfile
concern, not just a range concern: check `pnpm-lock.yaml`, not only
`package.json`. (The advisory lists a second range, `>=1.7.0-beta.0
<1.7.0-beta.10`; irrelevant here, the ceiling below excludes all of 1.7.)

### The ceiling: the adapter's peer, plus a dropped export

Every published adapter version — 0.12.2 through 0.12.5 — declares
`better-auth: ">=1.6.9 <1.7.0"` (0.12.3+ raise the floor to 1.6.11, never the
ceiling). **No adapter release supports better-auth 1.7 yet.** Hence `~1.6.30`
— patches inside 1.6.x, never 1.7.x. `^1.6.30` would resolve straight to
1.7.1, the current `latest` on npm.

The ceiling is not merely a declared peer, it bites. Measured on 2026-08-24
with 1.7.1 + adapter 0.12.2: **`tsc` passes clean, then `vite build` dies**

```
"./plugins/oidc-provider" is not exported ... from better-auth
```

The import is the **adapter's**, not ours — grepping this repo for it finds
nothing, and there is no local workaround. Note which gate caught it: type
checking was green on a build that cannot run. When you next evaluate a bump
here, `tsc` alone is not evidence.

### Why the adapter is pinned exact, and `~` wouldn't help

**On a `0.x`, `^0.12.2` and `~0.12.2` mean the same thing** — both read
`>=0.12.2 <0.13.0`, so neither blocks 0.12.3+. Only the bare `0.12.2` holds.

It has to hold, because the adapter breaks against newer Better Auth. From
better-auth **1.6.18**, `useSession().data` collapses to `never` and you get a
**TS2322 on the `authClient` prop of `ConvexBetterAuthProvider`**. Upstream
cause: 1.6.18+ gives its return types a *name* (`ReactAuthClient`) where they
used to be anonymous structural types, and the adapter's `AuthClient` — built
on `Omit<BetterAuthClientPlugin, …>` — no longer unifies with it.

### The bisect (adapter × better-auth)

| adapter    | better-auth | result                                                                                                             |
| ---------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| 0.12.2     | 1.6.16      | tsc OK, tests OK                                                                                                     |
| **0.12.2** | **1.6.30**  | **tsc OK, tests OK — the way out, and what we ship**                                                                 |
| 0.12.3     | 1.6.30      | tsc OK, but slows `convex-test` down: 2–4 tests out of 120 blow the 5 s timeout, a different set each run. Rejected. |
| 0.12.4     | 1.6.30      | TS2322                                                                                                               |
| 0.12.5     | 1.6.30      | TS2322                                                                                                               |

The `tests OK` / `convex-test` column comes from **interw-os**, a downstream
project that has a `convex-test` suite. This template ships none — don't go
looking for those 120 tests here. Locally the gates are `pnpm lint`,
`pnpm build` and `pnpm test:smoke`.

### `better-call` is no longer overridden

Better Auth pins `better-call` *exactly* (1.4.0 for 1.6.30), and this repo used
to force it back to 1.3.4. That override was **removed on 2026-08-24** — see
§ "pnpm.overrides" for why it existed and what it taught. `better-call` now
follows Better Auth with nothing in between, which is one less thing to reason
about when a bump goes wrong.

### Renovate guards the window, asymmetrically

In `renovate.json`: `@convex-dev/better-auth` is disabled outright (any bump
breaks it), whereas `better-auth` blocks only `minor`/`major` — **1.6.x patches
stay enabled on purpose**. That channel is how the next security fix arrives,
and closing it is exactly how this repo ended up shipping a vulnerable 1.6.14.
Don't "simplify" the two rules into one disabled rule.

### Unblock condition

**[get-convex/better-auth#420](https://github.com/get-convex/better-auth/issues/420)**
(open). When it lands, adapter 0.12.4+ should type-check against better-auth
1.6.18+. Only then relax the exact pin — and re-run the bisect above rather
than trusting the table, since the `convex-test` slowdown on 0.12.3 was a
separate defect from the TS2322.

## Zod v4 required for Better Auth 1.6.10

Better Auth's `better-call` subdependency uses `.meta()` on Zod schemas,
which is **v4-only**. The install warning is the only signal — runtime
errors otherwise look like opaque schema failures.

We ship `zod ^4.4.3`. Downgrading `better-auth` to a zod-v3-era release is
**not** an option any more: GHSA-qq9h-g4jm-xgf3 puts a hard floor at 1.6.22 —
see § "Better Auth is boxed into `>=1.6.22 <1.7.0`".

## Resend test-mode trap

`new Resend(component, { testMode: <bool> })` defaults to `true`. We pass
`testMode: process.env.RESEND_TEST_MODE !== 'false'` so production emails
actually fly. Symptom of the wrong setting: "Test mode is enabled, but
email address is not a valid resend test address".

**On sign-up that symptom is invisible.** Better Auth sends the verification
email as a *background task*, so the rejection never reaches the browser: the
account is created, the page says "check your inbox", and the only trace is a
`Failed to run background task` line in the Convex logs. Staging shipped that
way — the deployment had been created fresh, and a new deployment starts with
no environment variables at all. Only the manual "resend the email" endpoint
surfaces it, as a 500.

`convex/email.ts` now refuses to load when test mode is on and `SITE_URL`
resolves to a public host. The discriminator is `SITE_URL` rather than
`APP_ENV` on purpose: that staging deployment ran with `APP_ENV=development`
and a public address in front of it, so an `APP_ENV` guard would have stayed
silent exactly where it was needed. A deployment answering on a public host
has real people signing up on it, whatever it calls its environment.

## Resend: two integrations (runtime Convex vs Claude Code plugin)

There are **two unrelated Resend setups** in this repo and they read the
same env var name from **different places** — don't conflate them.

1. **Runtime email** (`@convex-dev/resend`, `convex/email.ts`). Sends the
   app's transactional mail (auth, invitations, notifications). Its
   `RESEND_API_KEY` and `RESEND_FROM` live in the **Convex deployment env**
   (`pnpm exec convex env set …`, or via `pnpm run setup`). Nothing here
   touches your shell.

2. **Dev tooling** (the `resend@claude-plugins-official` Claude Code plugin,
   enabled in `.claude/settings.json`). Its bundled MCP server runs
   `npx -y resend-mcp` and reads `RESEND_API_KEY` from the environment Claude
   Code passes it — **not** the Convex env, not `.env.local`. Put it in the
   **gitignored `.claude/settings.local.json`** `env` block (repo-scoped,
   never committed); **restart Claude Code** to apply. A shell-profile
   `export RESEND_API_KEY=re_…` also works.

A missing or wrong key produces different symptoms depending on which side:
app emails failing → check the **Convex** env; the Claude Code Resend tools
failing → check `.claude/settings.local.json` (or your shell) and restart.

**Why the plugin's skills aren't in `skills-lock.json`.** The plugin
delivers its skills *and* MCP as one marketplace bundle that auto-updates
at Claude Code startup. The `sync:skills` pipeline (`skills-lock.json`,
weekly Action) is only for library skills that upstream does **not** ship
as a Claude Code plugin (Convex, Better Auth, TanStack). Vendoring Resend
there too would duplicate the skills (plugin cache *and* `.agents/skills/`)
and double the update machinery — so we deliberately don't. Let the
marketplace own Resend.

## macOS Finder duplicates

Any `* 2.ts` / `* 2.tsx` file (created by Finder copy/paste or "Save as"
sidebars) will be picked up by Convex AND Vite and break the build with
ambiguous module errors. After heavy file-move ops, run:

```
find . \( -path ./node_modules -o -path ./.output \) -prune -o \
  -type f \( -name '* 2.ts' -o -name '* 2.tsx' \) -print
```

## The chat agent had its own provider, and its own key

`convex/agent.ts` ran on Anthropic (`claude-haiku-4-5`, `ANTHROPIC_API_KEY`,
overridable via an `ANTHROPIC_MODEL` env var) long after the interview
pipeline had deliberately consolidated onto one European provider. It read as
a separate concern — a chat assistant, not an evaluation — which is exactly
why it survived the consolidation.

It was not a separate concern. The agent's tools (`convex/recruiterTools.ts`)
read roles, candidates and reports, so a single question about a shortlist
sends candidate names and the text of their evaluations to the model. That is
interview data under a different name, and the residency argument in
`convex/lib/ai.ts` applied to it word for word.

Both now run on Mistral, on the model id exported from `convex/lib/ai.ts`, on
the one `MISTRAL_API_KEY`. Two consequences worth keeping:

- **No `ANTHROPIC_MODEL`, and no env var replacing it.** An id set from the
  environment is an id nothing type-checks or reviews. Change the model in
  `convex/lib/ai.ts` and re-run TESTING.md P4a — both halves of it, since that
  one id now drives `complete()` and the AI SDK client behind the assistant.
- **`convex/agent.test.ts` pins the provider.** Nothing in the type system
  stops `mistral.chat(...)` from becoming another provider's import again —
  the test is what makes that a failing build rather than a quiet regression.

The generalisable rule: when a product picks a provider for a data-protection
reason, the check is *which data reaches the model*, not which feature the
call belongs to. A read-only tool is still an egress path.

## SITE_URL drift in prod = broken email links

`SITE_URL` is the Convex env var that builds every email URL (magic link,
invitation accept, change-email verification, delete-account confirm) and
feeds Better Auth's `baseURL`. If you forget to set it on the prod Convex
deployment, emails ship with `http://localhost:3000/...` links — silent
data loss until a user complains.

`convex/auth.ts` throws at boot if `APP_ENV=production` AND `SITE_URL`
matches `localhost` / `127.0.0.1`. So:

- Set `APP_ENV=development` on dev deployments (no guard, localhost is fine).
- Set `APP_ENV=production` AND a real `SITE_URL` on prod. A `convex deploy`
  with the wrong combo will fail loudly.

```bash
pnpm exec convex env set --prod APP_ENV production
pnpm exec convex env set --prod SITE_URL "https://your-domain"
```

## `trustedOrigins` holds one origin per deployment

`convex/auth.ts` sets `trustedOrigins: [siteUrl]`. With each environment on
its **own** Convex deployment and `SITE_URL` (README § "Deploying: staging and
production"), that is not a limitation. It bites only when **two origins must
talk to the same deployment** — `localhost:3000` and a Vercel URL both on dev,
or a branch preview on staging: the second origin loads, then fails at sign-in.

The failure is misleading. A sign-up from an undeclared origin is rejected
with `Invalid origin` **before** any email is sent, so what people report is
"I never got the verification email". That has already cost an outage chased
on the email side. Check the request's `Origin` against the deployment's
`SITE_URL` first.

`siteUrl` is read **at module load**, so a warm isolate keeps the old value
until the functions are redeployed: `npx convex dev --once` on dev,
`npx convex deploy` with that environment's deploy key, from a checkout of
its branch, on staging and prod.

## Never put `CONVEX_DEPLOYMENT` on the hosting platform

`CONVEX_DEPLOYMENT` is a per-developer binding to your own dev deployment,
written into `.env.local` by `pnpm exec convex dev`. It is not a deploy
target. On the platform the target comes from `CONVEX_DEPLOY_KEY` alone, and
`convex deploy --help` documents `CONVEX_DEPLOYMENT` as a target of its own --
so a stray copy in the app's environment makes which deployment gets written
ambiguous, in production, silently.

If your local `CONVEX_DEPLOYMENT` goes missing because a tool overwrote
`.env.local`, re-run `pnpm exec convex dev` once and **pick the existing
deployment** — do not let it create a new one. Symptom is
`No CONVEX_DEPLOYMENT set` on the next `pnpm run setup:prod` or
`convex env list`.

## Vite / Convex dev fails after partial install state

If `pnpm dev` errors with one of:
- `_gensync(...) is not a function`
- `Cannot destructure property 'isCompatTag' of 'react'`
- `esbuild failed: import_esbuild2.default.build is not a function`

…the node_modules tree is in an inconsistent state (typically after a
mid-session `pnpm dedupe` or after pnpm skipped postinstall scripts on
`esbuild`).

**Fix**:
```bash
rm -rf node_modules
pnpm install
pnpm rebuild esbuild   # ensures esbuild's native binary is fetched
```

`pnpm rebuild esbuild` is required because pnpm 10 skips lifecycle scripts
by default, so esbuild's `install.js` doesn't download the platform binary.

## Nitro picks its preset from the build host

No `vercel.json` and no preset in `vite.config.ts`: Nitro auto-detects.

- **On Vercel** it selects the `vercel` preset — the build log says
  `[nitro:vercel] Using nodejs24.x runtime` — and emits `.vercel/output`, the
  Build Output API. `pnpm start` is never run there.
- **Everywhere else** (local, CI, any other Node host) it settles on the
  default `node-server` preset and emits `.output/server/index.mjs`, which is
  what `pnpm start` runs. `.output/server/` is self-contained — dependencies
  are bundled into `.output/server/_libs/` — and the server reads
  `process.env.PORT`. This is the escape hatch: the web tier leaves Vercel by
  building elsewhere, with no code change.

So a local `pnpm build` does not reproduce the artefact Vercel serves. When a
bug only shows up deployed, read the Vercel build log before bisecting code.

Confirm a build is servable without deploying anything:

```bash
VITE_CONVEX_URL=https://<deployment>.convex.cloud \
VITE_CONVEX_SITE_URL=https://<deployment>.convex.site \
  pnpm build:app
PORT=8080 pnpm start    # 200 on / and /login
```

**Those `VITE_*` values must be present for the build, not for the run.** Vite
inlines them into the bundle. Build without them and the server still boots
and still logs `Listening on:` — then fails the first render with
`CONVEX_SITE_URL is not set`, an error naming a *runtime* variable for what is
a *build-time* omission. Chasing that message by adding `CONVEX_SITE_URL` to
the running app appears to work on some paths and leaves the client bundle
wrong. The fix is always a rebuild with the variables present.

## Trade-offs vs PROJECT_BRIEF.md

Choices that diverge from the brief, with rationale. See
`/Users/benjaminbouquet/.claude/plans/glistening-puzzling-kay.md` for the full
audit.

- **Better Auth `organization()` plugin not loaded** — its tables are not Convex
  first-class (no `withIndex` joins). We mirror orgs/members/invitations in our
  own schema. Loss: `leaveOrganization`, session-level active-org, explicit
  reject/cancel invitation states.
- **AI front uses `useUIMessages` from `@convex-dev/agent/react`** instead of
  `@assistant-ui/react`. No Convex adapter exists for assistant-ui; the brief's
  pick would require ~200 lines of glue. Loss: markdown rendering, attachments,
  tool-call UI, edit/regenerate. Migrate later if polish is needed.
- **The chat agent runs the pipeline's model**, not a second provider chosen
  for cost/latency — see "The chat agent had its own provider, and its own
  key" above.
- **Rate-limit thresholds** chosen for usable defaults (e.g. invitations 20/h
  burst 5) rather than the brief's tight 3/min example.
- **Super-admin lacks impersonate** — out of scope for MVP, needs a careful
  session-signing flow.
- **Sentry only on the front-end** — Convex Dashboard logs cover errors;
  Sentry-on-Convex would need a fetch-to-envelope helper.

## Color theme picker SSR flash

The 4-theme picker (`ThemePicker.tsx`) reads `localStorage` in a `useEffect`
and applies `data-theme` to `<html>` after mount. Until then, the page
renders with the default neutral theme, which means a brief flash of color
on first paint when the user has a non-default theme saved.

`next-themes` already prevents the dark/light flash via its own pre-mount
script. The color theme is on a separate channel (data-theme attr vs class)
and doesn't get that treatment — acceptable for v1 since only the `--primary`
hue changes, not background colors.

**Fix later**: inject a synchronous `<script>` in `__root.tsx` that reads
the `app-color-theme` localStorage key and sets `data-theme` before React
hydrates. Or migrate to a cookie-based scheme so SSR can render the right
theme directly.

## i18n (react-i18next) SSR — no-flash, per-request instance

The app is bilingual (FR/EN). Three non-obvious decisions keep SSR correct:

1. **One i18next instance per server request, never a shared singleton.**
   `getI18n()` in `src/lib/i18n.ts` caches one read-only instance *per locale*
   on the server and a single mutable instance on the client. A single shared
   server instance whose `lng` we mutate with `changeLanguage` would leak one
   request's locale into another concurrent request (the Node server is
   long-running). The per-locale server cache is safe only because we never
   call `changeLanguage` on the server.

2. **Resources are imported statically (bundled), so init is synchronous.**
   No `i18next-http-backend`, no lazy namespace loading. That means the very
   first render already has the right strings — no Suspense boundary, no flash
   of keys or of the wrong language. The cost is all locales ship in the
   bundle; fine for two languages, revisit if the count grows.

3. **The locale cookie is written on the server during SSR.**
   `getLocale()` (`src/lib/locale.ts`) is a `createIsomorphicFn`: on the server
   it reads the `lang` cookie, else parses `Accept-Language`, then **writes the
   resolved value back into the `lang` cookie**. The client branch reads the
   same cookie (else `navigator.language`). Writing the cookie server-side is
   what guarantees the client reads the *exact* value the server rendered with —
   without it, `Accept-Language` (server) vs `navigator.language` (client) can
   disagree and cause a hydration mismatch. This is the cookie-based approach
   the "Color theme picker SSR flash" section suggests as the future fix —
   applied here from the start. English is the default; French wins only when a
   French variant is the highest-priority language the client asked for.

**Page `<title>` in `head()`**: `head()` runs outside React, so it can't use
the `useTranslation` hook. Routes resolve titles via
`getI18n(getLocale()).getFixedT(null, '<ns>')('key')` instead. A live language
switch updates the body immediately but the `<title>` only refreshes on the
next navigation — acceptable, titles are low-traffic.

**Cross-device preference**: `users.preferredLanguage` (Convex) is written by
the switcher and drives transactional email locale. We do **not** currently
restore it into the cookie on login, so switching language on device A does not
auto-apply the UI language on device B until the user switches there too (the
cookie is per-browser). The email locale is always correct regardless. Restore
on login is a deliberate follow-up, not a bug.

**zxcvbn feedback strings** (password strength warnings) come from the zxcvbn
English wordlist and are not translated — only our own labels around the meter
are. Translating zxcvbn output would require loading its locale packs.

## Browser-only libs (anything `window`-touching) need client-only mount

Libraries that reference `window` at module load time (Leaflet, Chart.js,
Mermaid, Three.js, …) crash SSR on TanStack Start with
`ReferenceError: window is not defined` if imported at the top of a route
file — routes render on the server by default.

**Pattern**: keep only `import type` at module level, load the real modules
in a `useEffect` via dynamic `import()` (including any side-effect CSS like
`leaflet/dist/leaflet.css`), stash them in state, and render a skeleton
until they land:

```tsx
function ClientOnlyWidget() {
  const [mods, setMods] = useState<Mods | null>(null)

  useEffect(() => {
    let cancelled = false
    Promise.all([import('some-browser-lib'), import('some-browser-lib/styles.css')])
      .then(([lib]) => {
        if (cancelled) return
        setMods({ Widget: lib.Widget })
      })
    return () => { cancelled = true }
  }, [])

  if (!mods) return <Skeleton />
  return <mods.Widget>…</mods.Widget>
}
```

(The demo map page that originally motivated this was removed in v0.1.0,
but the trap applies to any browser-only lib you add.)

## Convex dev typecheck

`pnpm exec convex dev` runs its own typecheck (`--typecheck=enable`). If
that fails the deploy is rejected. Use `pnpm typecheck` separately to keep
the local feedback loop tight; the Convex check catches the same errors at
deploy time anyway.

## Post-event notification coverage

`notifications.notifyPasswordChanged` fires from the client right after
`authClient.changePassword()` succeeds on `/app/me`. **It does NOT fire on
the `/forgot-password` → `/reset-password` flow** because that path runs
server-side inside Better Auth and we don't have a clean hook (BA exposes
`sendResetPassword` for sending the *link*, not a post-reset callback). The
existing `revokeSessionsOnPasswordReset: true` covers the takeover-mitigation
side (all sessions revoked, user must re-auth) so a hijacker is locked out;
the missing piece is the *informational* email to the rightful owner.

The mutation is public and cannot tell a real change from a replay, so it
consumes the per-user `passwordChangedNotify` bucket (3/h, burst 2) before
sending; the client's fire-and-forget call absorbs a `rate_limited` silently.

Two paths if/when this matters:
1. Add `databaseHooks.account.update.after(account)` in `convex/auth.ts` and
   gate on `providerId === 'credential'`. Risk: BA's `databaseHooks` type
   surface is heavy and may trigger the TS inference cycle that CLAUDE.md
   anti-pattern flags. Try in isolation.
2. Add a thin wrapper around `authClient.resetPassword()` that, on success,
   POSTs to a public Convex mutation. Symmetric to the `/me` pattern but
   needs the user's email — derivable from the JWT BA sets on the response,
   or by passing it through the reset-password page state.

**NewDeviceEmail** is not implemented for the same scoping reason: detecting
"new device" requires storing UA fingerprints in our schema (BA's component
tables aren't queryable from `ctx.db` directly). Tracked as Phase 3 work
behind a dedicated PR — needs a `deviceFingerprints` table + a session-create
hook + an action to send the email.

## Hydration & session timing — never re-instantiate `ConvexQueryClient`

### Symptom (dev-only)

In localhost, hard-refreshing `/app/*` redirects to `/login` for a beat,
then snaps back. Opening a second tab to `/app/*` does the same. Prod is
fine (network is fast enough that the gap closes inside React's batching).

### Root cause

`src/router.tsx` is `getRouter()` — TanStack Start calls it on the server
AND again on the client during hydration. If `getRouter()` creates
`new ConvexQueryClient(...)` on every call, each call opens a fresh
WebSocket. The new socket has no JWT yet, so `useConvexAuth()` reports
`{ isLoading: false, isAuthenticated: false }` for the round-trip while
BA's cookieCache already knows the user is signed in. Any guard that
redirects on `!isAuthenticated` will fire during that gap.

### Rule

1. **Memoize `ConvexQueryClient` and `QueryClient` at module scope on the
   client** (`typeof window !== 'undefined'` check). Reuse across all
   `getRouter()` calls. See the `getOrCreateClients()` helper in
   `src/router.tsx`. On the server, always create fresh — the singleton
   would leak state across requests.

2. **Don't redirect on `useConvexAuth()` alone**. Use the `useAuthState()`
   hook in `src/lib/auth-state.ts`, which combines Convex's signal with
   Better Auth's `useSession()`. Only redirect when BA confirms no
   session (`isSignedOut`), not when Convex is mid-refresh.

3. **Anti-pattern** already listed in `CLAUDE.md` (« ❌ `ConvexReactClient`
   recreated each render ») — this is the same bug at the router level.
   If you add a new route guard, prefer `useAuthState()` over
   `useConvexAuth()` directly.

## Hot `users` row — a write there invalidates EVERY open query

Every query and mutation in this app resolves the caller through
`requireAppUser` / `safeAppUser` (`convex/lib/auth.ts`), which reads the
caller's `users` row. That row is therefore in the **read set of every open
subscription**. Convex re-runs a query whenever anything in its read set
changes, so **one write to the `users` row re-executes ALL mounted queries**
for that user — across every tab.

### The trap we hit (4.8 GB on a 1 GB Free quota)

`lastOrgSlug` used to live on the `users` row, and
`src/routes/app/$orgSlug/route.tsx` fired `organizations.setLastOrg` from a
`useEffect` that depended on `users.me`. Two tabs open on two different orgs
turned that into an infinite cross-tab loop: tab A writes its slug → the
`users` row changes → `me` re-runs in tab B → B's effect writes *its* slug
back → A's effect fires again, forever. Each write also re-ran every other
mounted query (dashboard, lists, members…). A derived project with 2 users
and ~10 MB of data burned **4.8 GB of Database Bandwidth** this way.

### Two rules to avoid a recurrence

1. **No frequently-written field on `users`.** Per-user mutable state goes to
   `userPrefs` (`convex/lib/userPrefs.ts`) or its own dedicated table, which
   only `users.me` reads — a write there invalidates that single cheap query
   instead of the whole subscription set. `users` stays for stable identity
   data (email, name, `superAdmin`, …).
2. **Never fire a mutation from a `useEffect` that depends on a Convex query
   observing the data being written.** That is the loop above. When a one-shot
   sync is genuinely needed, guard it with a "write-once per intention"
   `useRef` (see `lastOrgSyncedRef` in `app/$orgSlug/route.tsx`): persist at
   most once per visited slug so a `me` update from another tab can't
   re-trigger the write.
3. **Moving a field off `users` is a schema *narrow* — widen + deprecate, do
   not delete in the same shippable change.** Convex validates the new schema
   against documents at rest, and `convex deploy` runs inside the platform's
   `pnpm build`. Removing `lastOrgSlug` from the `users` validator while prod
   rows still carried it failed the production deploy with
   `Object contains extra field `lastOrgSlug` that is not in the validator`
   (Vite built fine — the failure is the Convex push, not the bundle). Fix:
   keep the field as `v.optional` with a `// Deprecated` comment and read it as
   a fallback in `getLastOrgSlug` (writes still go only to `userPrefs`, so the
   hot-row win holds). Only narrow the validator in a *later* deploy, after a
   migration has cleared the field from every row — the widen → migrate →
   narrow pattern.

## release-please was removed (failed on every merge with `other side closed`)

The `release-please.yml` workflow turned the **Release please** check red on
every push to `main` with:

```
release-please failed: other side closed
```

`other side closed` is an undici socket error during the action's GitHub API
calls. Forcing the action onto Node 24 (`FORCE_JAVASCRIPT_ACTIONS_TO_NODE24`)
did **not** fix it — the run still failed and still reported running on Node 20,
so the env var never switched the runtime. It never produced a tag, a
`CHANGELOG.md`, or a release PR.

**Decision: the workflow was deleted.** This template deploys continuously on
its hosting platform (independent of GitHub Actions), so automated version tags
/ changelogs weren't needed. Deleting it does not affect deploys or the `ci.yml` typecheck.

If you later want automated releases, don't just re-add the old file — it had
two latent problems on top of the crash: `package.json` has no `version` field
(`release-type: node` needs one) and there was no `release-please-config.json` /
`.release-please-manifest.json` bootstrap, so the first run scanned all history
unbounded. Set those up before re-enabling.

Field data from a derived project (2 weeks in) confirms the removal:
the workflow failed 47/47 runs with `GitHub Actions is not permitted to create
or approve pull requests` (the Actions setting is off by default on new
repos), and even repaired it would have produced empty changelogs because the
commits there don't follow Conventional Commits. Re-enabling needs all four:
the Actions setting, the `version` field, the manifest bootstrap, **and**
Conventional Commits discipline. For this template's actual release flow
(manual notes + tag), see `release-tag.yml`.

## sync-skills.yml (cron + auto-PR) was removed — CI drift check replaced it

A weekly workflow (Monday cron + `peter-evans/create-pull-request`) used to
open a `chore/sync-skills` PR when upstream SKILL.md files changed. Removed
because every link in its chain was fragile while the alternative needs zero
setup:

- The PR step fails with `GitHub Actions is not permitted to create or
  approve pull requests` unless a repo Actions setting (off by default, and
  org-gated for org repos) is flipped on every derived repo.
- Even then, PRs opened with the default `GITHUB_TOKEN` don't trigger
  `on: pull_request` workflows — the bot PR shows no CI checks unless you
  close/reopen it or wire up a PAT.
- Crons are best-effort: they only run from the default branch, GitHub
  auto-disables them on public repos after 60 days of inactivity, and on a
  derived project the Monday cron never fired once in 2 weeks.

Replacement: the `skills-drift` job in `ci.yml` runs
`node scripts/sync-skills.mjs --check` on every push/PR (the script is
dependency-free — no `pnpm install`). Red job → `pnpm run sync:skills:update`,
review the diff, commit. Drift surfaces exactly when someone is coding,
which is the only time fresh skills matter.

Because that cron is gone, `skills-drift` is the **only** thing watching
upstream here, so it stays in CI even though it needs the network. A derived
project that *keeps* a weekly sync cron can drop `skills-drift` from CI and rely
on `skills-verify` alone, for a 100 % offline CI — that's what Interw OS did. Do
not port that change back here without restoring a cron first.

## Vendored skills: cross-family links, and why `..` is banned in `references`

Upstream repos increasingly ship *trees* of skills (TanStack/router:
`packages/<pkg>/skills/<skill>/[<sub>/]SKILL.md`). We vendor flat, one lock key
per family: `.agents/skills/<name>/`. Two consequences:

- **Sibling links inside a family resolve, links climbing out of it don't.**
  A sub-skill vendored as a `reference` keeps its position relative to its
  parent, so `./middleware/SKILL.md` and `../server-functions/SKILL.md` work.
  But upstream also links *across* packages
  (`../../../../router-core/skills/router-core/auth-and-guards/SKILL.md`), and
  that prefix doesn't exist locally — 17 such links currently dangle. We do
  **not** rewrite them at vendor time: `computedHash` is computed on the fetched
  bytes, so patching links on write would make the working tree permanently
  disagree with the hash, and every `--check` would look like drift. The mapping
  lives in `CLAUDE.md` § Skills instead.
- **A `references` entry must never start with `..`.** It looks like it works —
  `raw.githubusercontent.com` normalises the path and returns 200 — but
  `vendor()` resolves the same string against `.agents/skills/<name>/` and
  writes **outside** the skill directory. That's why
  `compositions/router-query`, a *sibling* of `react-router` upstream, is its own
  lock entry (`tanstack-router-query`) rather than a `../` reference.

Rule of thumb: one lock entry per upstream directory you want to root a tree at;
`references` may only point at descendants of that directory.

## `sync:skills --check` needs its in-flight fetches capped

`runCheck` fans out over every skill at once, and each skill with `references`
multiplies its own file count. Vendoring the TanStack tree took the check from
~30 to ~53 files and it started failing consistently: past roughly 30 parallel
TLS handshakes `raw.githubusercontent.com` stops answering, undici burns its
full 10 s connect timeout, and the script dies with `TypeError: fetch failed`.
That breaks two things at once — the `SessionStart` hook in `.claude/settings.json`
has a 10 s budget, and the `skills-drift` CI job goes red for no real reason.

Fixed in `scripts/sync-skills.mjs` with an 8-slot semaphore around `fetch`
(`MAX_IN_FLIGHT`). Counter-intuitively this made the check ~4× *faster* than it
ever was (0.3–0.5 s vs 1.3–7.8 s), because ≤8 sockets get reused instead of
thrashing. If you add many more skills, raise the skill count freely — do not
raise `MAX_IN_FLIGHT`.

The `skills-drift` CI job still carries this network exposure, by design (no
cron here — previous section). The `skills-verify` job doesn't: it is a pure
local re-hash and issues zero requests, so tree-integrity failures are never
confounded with a GitHub hiccup.

## `--check` is blind to the working tree — hence `--verify`

`--check` and the default mode both compared **the lock's hash to upstream**,
never **the lock to the disk**: `isVendored()` only tested that the files
*exist*. So a vendored file hand-edited, truncated or simply left stale was
invisible from both sides. Reproduced on this repo:

```
$ node scripts/sync-skills.mjs --check          # green
$ echo "CORRUPTION" >> .agents/skills/convex-create-component/SKILL.md
$ node scripts/sync-skills.mjs --check          # STILL green, exit 0
$ node scripts/sync-skills.mjs                  # "Skills up to date." — no repair
```

Note the exact shape of the hole: **deleting** a file *was* caught (the
existence test), **modifying** its content was not. That's what let three Convex
`references/` files rot after their manual backfill, `migrations-component.md`
being 54 lines behind. Nothing could ring.

Two modes, two questions, not interchangeable:

| Mode       | Question                  | Network |
| ---------- | ------------------------- | ------- |
| `--verify` | is my tree intact?        | no      |
| `--check`  | has upstream moved?       | yes     |

### Second hole, same family: an unreachable skill used to pass

`--check` had a third possible outcome nobody counted — *we failed to look*.
A fetch error set `process.exitCode = 1`, but the function ended with
`process.exit(drift > 0 ? 2 : 0)`, and **`process.exit()` overrides
`process.exitCode`**:

```
$ node -e "process.exitCode = 1; process.exit(0)"; echo $?
0
```

So with `drift === 0`, a skill 404-ing upstream — or the whole network being
down — printed **"Skills up to date with upstream." and exited 0**. The one
thing that saved us was a coincidence: 3 Convex skills 404'd *and* 2 others
drifted, so `drift` was 2 and the job went red for the wrong reason. Resolve
the drift and the 404s would have gone silent.

`--check` now counts `unreachable` separately, reports it on its own line, and
fails on `drift > 0 || unreachable > 0`. **A 404 is worse than drift, not
better**: drift means upstream changed, 404 means it's gone or renamed and the
skill is no longer tracked by anything.

Both run in CI here (`skills-verify`, `skills-drift`). `--verify` is the cheap
deterministic gate; `--check` stays because this repo has no sync cron to catch
upstream drift otherwise.

The default mode is now **self-healing** too: it rewrites any file that no
longer matches `computedHash`, so a plain `pnpm run sync:skills` repairs a
corrupted tree. `--force` is no longer needed for that (it remains useful to
re-download everything unconditionally).

### Third hole, same family: a pruned skill left its symlink behind

Both gates iterated `lock.skills`. So they could only ever ask questions *about
entries that exist* — a skill **removed** from the lock fell out of their field
of view entirely, taking its `.claude/skills/<name>` symlink with it.

That is exactly what PR #59 did: it pruned five Convex skills from
`skills-lock.json` and deleted `.agents/skills/convex*`, but nothing removed the
five symlinks, and they are tracked files — so they were *committed dangling*:

```
$ find .claude/skills -type l ! -exec test -e {} \; -print
.claude/skills/convex-setup-auth
.claude/skills/convex-migration-helper
.claude/skills/convex
.claude/skills/convex-quickstart
.claude/skills/convex-performance-audit
```

Claude Code walks `.claude/skills/`, not the lock, so it kept advertising five
skills whose `SKILL.md` was gone. `--verify` said "Vendored skills match", CI
was green, and the PR that caused it was the *skill-pruning* PR — the one place
you would expect someone to look.

`orphanLinks()` now closes it: `--verify` reports any `.claude/skills/` symlink
with no lock entry, and a plain `sync:skills` unlinks it. Two safety belts keep
it narrow — it only considers **symlinks** (a real directory is left alone) and
only those resolving **inside `.agents/skills/`**, so a hand-placed skill or a
link to somewhere else is never deleted. Pruning has its own counter, so a run
that only removes orphans does not rewrite `skills-lock.json`.

**The rule this leaves you with**: removing a skill is *two* deletions. Drop the
lock entry, then run `pnpm run sync:skills` and commit the symlink deletion in
the same PR.

## `web-design-guidelines` vendors `AGENTS.md`, not the SKILL.md you'll find on GitHub

Search GitHub for `web-design-guidelines/SKILL.md` and you get 100+ hits. They
are all copies of the same community wrapper, and vendoring one would be a
mistake. The wrapper's entire body is an instruction to fetch the real rules at
runtime:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Pin that and you pin 1.2 kB of "go read a URL". The 7.7 kB that actually steers
the model is never hashed, never reviewed, and changes under you — so
`sync:skills:check` reports "up to date" forever while the content it is
supposed to guard drifts freely. It also turns every invocation into a network
call and an unreviewed prompt-injection surface, which is precisely what the
pin-and-hash pipeline exists to prevent.

We vendor the canonical `vercel-labs/web-interface-guidelines` instead. Two
files there could serve:

| Upstream file | Shape | Verdict |
| ------------- | ----- | ------- |
| `command.md`  | slash-command frontmatter + `$ARGUMENTS` + an output format | ✗ already has frontmatter (prepending ours yields two blocks), and `$ARGUMENTS` is meaningless outside a slash command |
| `AGENTS.md`   | the rules alone, MUST/SHOULD/NEVER, no frontmatter | ✓ |

`AGENTS.md` has no frontmatter at all, which the spec requires (`name` +
`description`, `name` matching the directory). Hence the `frontmatter` map in
the lock entry — see `CLAUDE.md`. It is prepended before hashing, so `--check`
and `--verify` still digest identical bytes and an edit to the block shows up as
drift.

Consequences worth knowing:

- **Upstream may add frontmatter to `AGENTS.md` one day.** That would produce
  two blocks and a broken skill. `skills-drift` fires first (the content
  changed), so read the diff before `--update` — that is the check, not an
  accident.
- **`name` must keep matching the directory**, i.e. the lock key. Rename one and
  you must rename both.
- The upstream project calls this **"Web Interface Guidelines"**; we keep the
  directory name `web-design-guidelines` because that is what the ecosystem's
  copies are called and what people search for.

## Streamdown (AI panel) — `@source` Tailwind v4, plugins removed

The AI panel renders assistant markdown with `streamdown` (via
`MessageResponse` in `src/components/ai-elements/message.tsx`). Two traps if
you touch this area:

1. **Unstyled markdown.** Streamdown styles its elements with Tailwind classes
   that live inside `node_modules`. The line
   `@source '../../node_modules/streamdown/dist/*.js';` in `src/styles/app.css`
   is mandatory — without it, Tailwind v4 doesn't scan the package and all
   assistant markdown renders raw.
2. **Plugins removed on purpose.** Upstream AI Elements' `message.tsx` imports
   `@streamdown/{code,math,mermaid,cjk}` (Shiki + KaTeX + Mermaid = megabytes).
   We keep only the core (GFM: tables, lists). Likewise `tool.tsx` replaces the
   upstream Shiki `CodeBlock` with a local `<pre>`. Comments mark both trims in
   the files.

## AI Elements (AI panel) — trimmed vendoring

The panel uses a small subset of Vercel AI Elements, vendored in
`src/components/ai-elements/` and **deliberately trimmed**. Re-apply these
after any reinstall from the registry (`npx ai-elements@latest add <name>`):

- `prompt-input.tsx` is a **minimal rewrite**. Upstream ships attachments + a
  model picker, pulling in `command` / `hover-card` / `input-group` / `nanoid`;
  the panel only needs a multiline composer + submit/stop, so we vendor a tiny
  version exporting `PromptInput*` + `PromptInputMessage`.
- `message.tsx` uses `size="icon"` on action buttons. Upstream uses an
  `icon-sm` size; this template's `Button` has no such variant (and we don't
  hand-edit `src/components/ui/*`), so we map it down.
- `streamdown` plugins and the `tool.tsx` `CodeBlock` are trimmed — see the
  "Streamdown (AI panel)" section above.

## Tool approval (AI panel) — resuming the stream is mandatory

The agent's write tools carry `needsApproval: true` (`createTool` from
`@convex-dev/agent`). Four traps:

1. **Generation does NOT resume on its own.** `approveToolCall` /
   `denyToolCall` only record the decision and return a `messageId`; you MUST
   re-run `streamText` with `promptMessageId: messageId`, or the thread stays
   frozen on "Confirmation required". `chat.respondToToolApproval` does exactly
   this (decision → re-schedule `internal.chat.streamAsync`). Any new approval
   entry point must follow this contract.
2. **Minimum `@convex-dev/agent` 0.6.2.** Below that, the message is duplicated
   after approval with `saveStreamDeltas` and the final step isn't persisted
   (get-convex/agent#185, fixed in 0.6.2). We are on `^0.6.3`.
3. **Built-in auto-deny.** Sending a new message while an approval is pending
   auto-denies it (reason `auto-denied: new generation started`). Intended —
   the UI shows "Action rejected"; don't "fix" it.
4. **Approval state rides the tool parts** of `useUIMessages`
   (`approval-requested` → `approval-responded` → `output-available` /
   `output-denied`, field `part.approval`) — `confirmation.tsx` is driven by
   that. `dynamicTool()` does not support approval (vercel/ai#11434): don't
   convert these tools to dynamic.

---

# Interw

Traps found while building the interview product on top of this template.

## `npx convex codegen` needs a live deployment

### What went wrong

Adding a Convex module and then running `pnpm typecheck` fails with
`Property 'projects' does not exist on type ...` — because
`convex/_generated/api.d.ts` still lists the old module set. The obvious fix,
`npx convex codegen`, refuses:

```
✖ No CONVEX_DEPLOYMENT set, run `npx convex dev` to configure a Convex project
```

Setting a dummy deployment gets further and then fails on
`Error fetching GET https://api.convex.dev/... 401 Unauthorized`. Codegen
authenticates before it writes anything. CI has no deployment either, so this
is not only a local problem.

### The rule

Run `pnpm codegen:api` after adding, renaming or deleting a Convex module.
`scripts/codegen-api-types.mjs` regenerates the two mechanically derived
blocks of `api.d.ts` — the module map from the filesystem, the components map
from `convex.config.ts`. `api.js` is generic at runtime (`anyApi`,
`componentsGeneric`), so this only affects the type checker, and
`npx convex dev` overwrites the file with identical content on its next run.

`pnpm codegen:api:check` runs in CI and fails when a module was added without
committing its codegen.

**This does not license hand-editing `convex/_generated/*`** — the CLAUDE.md
rule stands. This is codegen, verified byte-faithful against the tool's own
output before it was adopted. If you find yourself editing that file in an
editor, stop.

## Bumping `convex` is never one package

`convex` 1.41 added a `transactionLimits` option to `runQuery` / `runMutation`,
widening their signature from `OptionalRestArgs` to `ArgsAndOptions`. A
`@convex-dev/*` component built against an older peer still declares its own
`RunMutationCtx` with the narrow signature, so handing it our `ctx` stops
type-checking:

```
convex/http.ts(24,50): error TS2345: Argument of type 'GenericActionCtx<any>'
  is not assignable to parameter of type 'RunMutationCtx'. […]
  Target allows only 1 element(s) but source may have more.
```

The error names our file and our `ctx`, and neither is at fault. The fix is to
bump the component — never to cast the `ctx`, which would hide the next one.
Here it was `@convex-dev/resend`, which needed 0.2.5+ (`convex@^1.43.0` from
0.2.7). The same holds for any component whose peer floor sits below the
`convex` you are moving to, so bump `convex`, run `pnpm typecheck`, and let it
name the offender before touching anything else.

`convex-test` was pinned to 0.0.54 for the mirror-image reason while the
project shipped `convex` 1.40: 0.0.55+ declares `convex@^1.43.0` and failed at
runtime on the first `t.run()` with

```
Error: Transaction already committed or rolled back
```

which looks like a bug in your test and is not. Moving `convex` to 1.46
unblocked it, and it now sits at 0.0.58. Note the range stays effectively
exact either way: on a `0.0.x` version `^0.0.58` reads `>=0.0.58 <0.0.59`, so
every further step is a deliberate bump, not a float.

A `convex` bump also rewrites `convex/_generated/server.d.ts` (1.44 added the
typed `env` export carrying `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL`). Commit it
with the bump: `pnpm codegen:api:check` only guards `api.d.ts`, so a stale
`server.d.ts` sails through CI and reappears as a phantom diff for whoever
next runs `convex dev`.

## Convex type inference collapses on two specific cycles

Both produce the same misleading symptom: `tsc` reports
`Parameter 'x' implicitly has an 'any' type` in files you did not touch,
often in `src/routes/`, and the real cause is in `convex/`.

**1. An action calling its own module through `ctx.runQuery` / `ctx.runMutation`.**
Annotate the handler's return type explicitly:

```ts
export const requestQuestionUpload = action({
  args: { ... },
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; key: string; contentType: string }> => {
    const target = await ctx.runQuery(internal.media.resolveQuestionUpload, args)
    ...
  },
})
```

**2. A module-level client configured with a function reference.**
`convex/email.ts` passes `onEmailEvent: internal.emailEvents.record` to
`new Resend(...)`. `internal` is typed from every Convex module including
that one, so without an explicit annotation TypeScript walks into the cycle,
infers `any` for `resend`, and poisons inference across the whole backend:

```ts
export const resend: Resend = new Resend(components.resend, { ... })
```

Same family as the Better Auth trigger cycle documented above. When `tsc`
starts reporting implicit `any` in unrelated files, look for a new function
reference in a module-level initialiser.

## Convex storage ids have no owner — our rows are the ownership record

`_storage` carries no owner field and `ctx.storage.delete` accepts any id. So a
mutation that takes an `Id<'_storage'>` from a client must refuse an id another
row already references, and must delete a blob only when no other row still
points at it — `claim` in `convex/files.ts`, `heldElsewhere` / `release` in
`convex/lib/storage.ts`. And a raw storage id
never reaches a client: resolve it to a URL server-side.
`organizations.bySlug` used to spread the whole row, handing every member the
logo's handle, which `setMyAvatar` then accepted and `removeMyAvatar` deleted
(audit 2026-09-22, `convex/files.ts:setMyAvatar:storageId-unbound-to-caller`).

Every path that clears an avatar or a logo — `setMyAvatar`, `removeMyAvatar`,
`setOrgLogo`, `removeOrgLogo` and `users.cascadeDelete` — goes through
`release`, never a bare `ctx.storage.delete`, so a blob two rows already shared
before `claim` existed survives until its last holder lets go.

## Candidate recordings are NOT in Convex file storage

`ctx.storage.getUrl()` returns a **permanent, unauthenticated** URL. Convex's
own documentation is explicit: "anyone with the URL can access the file
without further authentication from your app", and the only way to revoke one
is to delete the file. Such a URL, once written to a database, mailed, or left
in a browser history, exposes a candidate's video irrevocably.

Serving through a Convex HTTP route is not a way out either: HTTP responses
cap at 20 MB and do not support range requests, so neither a long recording
nor seeking would work.

Everything a candidate produces — and every recruiter-recorded question,
because a recruiter's face and voice are personal data too, and a permanent
link to the question set leaks the interview itself — goes to the private
S3-compatible bucket via `convex/lib/objectStore.ts`. Only branding images
(org logo, persona avatar) stay in Convex storage.

**Never "simplify" this by moving recordings back to `ctx.storage`.** It is
the one change that would reintroduce the exact failure this architecture
exists to prevent.

## A presigned PUT signs content-type AND content-length

`presignPut` puts both headers in the signature, deliberately: the first stops
an upload slot issued for a video from being used to park HTML on the bucket's
own origin, the second stops a 4 MB promise becoming a 40 GB upload.

The cost is that the client must send **exactly** what was signed. `fetch`
does this automatically for a `Blob` — it sets `Content-Length` from
`blob.size` and takes `Content-Type` from the header you pass. A hand-rolled
request, a proxy that re-encodes, or passing a different blob than the one
whose size you declared, all produce a `403` that reads like a credentials
problem and is not.

If a `403` appears on upload: compare the blob's size and type against the
arguments passed to `requestSegmentUpload` / `requestQuestionUpload`.

## `SignatureDoesNotMatch` is usually addressing style, not the key

`convex/lib/objectStore.ts` defaults to virtual-hosted addressing
(`https://{bucket}.{endpoint}/key`), which AWS, Scaleway and R2 all accept.
MinIO in local development generally does not — set
`OBJECT_STORE_FORCE_PATH_STYLE=true`. The second-most common cause is
`OBJECT_STORE_REGION` not matching the endpoint's region: the region is part
of the signing scope, so `fr-par` against an `nl-ams` endpoint signs cleanly
and is rejected on arrival.

The signer itself is pinned by `convex/lib/sigv4.test.ts` against AWS's own
published worked example — both the canonical request and the final
signature. If those tests pass, the signer is not the problem.

## Two `MediaRecorder`s run on one camera stream

`SegmentRecorder` records the answer twice: video-with-sound, and audio alone
(a second `MediaStream` built from the audio track — not a clone of the whole
stream, which would carry the video track into the "audio" file).

This is not redundancy. The audio track is what gets transcribed and measured,
and handing a transcription model a WebM **video** container is the difference
between a timestamped transcript and a provider error. The extra upload is a
few hundred kilobytes against a recording of tens of megabytes.

## Seeking a `<video>` before `loadedmetadata` is silently ignored

Setting `video.currentTime` before metadata has loaded does nothing — no
error, no warning — and the video plays from the beginning. This is how
"jump to the quote" quietly becomes "plays from the start", which reads as a
broken feature rather than a race.

`AnswerPlayer` waits for `readyState >= 1`, or listens once for
`loadedmetadata`. It also carries a **nonce** on the seek cue, because
clicking the same quote twice must replay it and a plain
`{ segmentId, seconds }` object would compare equal.

## Para-verbal analysis is computed, not generated

The six delivery figures (speaking rate, hesitation, silence, time used,
consistency, speaking time) come from `convex/lib/paraverbal.ts`, computed
deterministically from the transcript's timestamps. No model scores them.

This stack has no audio-capable model. A "vocal warmth" or "confidence" score
would therefore be an invention wearing the clothes of a measurement — and
nothing in a hiring report may be invented. Rate, hesitation and pausing are
the measurable substance of para-verbal delivery anyway, they cost nothing
extra, and being deterministic they are unit-tested and identical on a replay,
which the pipeline's idempotency requires.

If an audio-capable model is added later, extend the dimension union in
`convex/schema.ts` — do not quietly start generating the existing six.

## The shadcn CLI rewrites files you did not ask it to

`pnpm dlx shadcn@latest add alert-dialog switch` also rewrote
`src/components/ui/button.tsx` to a newer registry revision and added a
package called `cn` to `dependencies`. The new revision imports
`from "cn"` and `from "radix-ui"`, neither of which matches this project
(`~/lib/utils` and `@radix-ui/react-*`), so the build breaks in a way that
looks unrelated to the component you were adding.

After any `shadcn add`: read `git diff` before staging. Revert files you did
not ask for, re-point `cn` imports at `~/lib/utils`, and check `package.json`
for a dependency you did not want.

## TypeScript narrows a `let` flag captured by an async closure

The standard cancellation pattern fails ESLint's
`no-unnecessary-condition` rule:

```ts
let cancelled = false
void (async () => {
  await something()
  if (cancelled) return   // "value is always falsy"
})()
return () => { cancelled = true }
```

TypeScript cannot see that the cleanup mutates the flag after the closure is
created, so it narrows `cancelled` to `false` for the rest of the block. Put
the flag on an object (`const run = { cancelled: false }`), and prefer a
single check after all the awaiting and before any state is touched — so
nothing half-applies when the user has navigated away.

## Testing the pipeline: the Workpool under `convex-test`

Two things bite when a test drives the real work pools rather than calling the
pipeline's mutations by hand. Both are in `convex/fanin.test.ts`.

### `finishAllScheduledFunctions` never returns

A `Workpool` keeps a supervisor loop that reschedules itself for as long as
the pool exists, so "every scheduled function has finished" is a state it
never reaches. `t.finishAllScheduledFunctions(vi.runAllTimers)` throws
`too many iterations` after a while, and the diagnosis it suggests —
infinitely recursive scheduled functions — is a red herring: the pool is
working exactly as designed.

Drive it in bounded steps instead:

```ts
for (let i = 0; i < 60; i++) {
  await vi.advanceTimersByTimeAsync(30_000)
  await t.finishInProgressScheduledFunctions()
}
```

Advancing the clock matters: it is what carries a job through the pool's retry
backoff to a terminal failure, which is the state the fan-in has to handle.

Related, and easy to lose an hour to: `finishInProgressScheduledFunctions`
waits only on scheduled callbacks that have **already fired**. A mutation that
calls `ctx.scheduler.runAfter(0, …)` leaves a real `setTimeout(0)` behind, so
calling it on the next line finds nothing in flight and returns immediately —
the scheduled work then runs after your assertions. Yield to the macrotask
queue first:

```ts
await t.mutation(api.admin.relaunchSession, { sessionId })
await new Promise((resolve) => setTimeout(resolve, 0))
await t.finishInProgressScheduledFunctions()
```

### `@convex-dev/workpool/test` breaks `pnpm typecheck` for the whole repo

The `./test` subpath export points at the package's raw `src/test.ts`, not at
a build, so `tsc` follows it into `src/component/shared.ts` — which has an
unused local. Under our `noUnusedLocals` that is an error, in a file we do not
own, and it fails the repo's typecheck:

```
node_modules/…/@convex-dev/workpool/src/component/shared.ts(71,7):
  error TS6133: '_' is declared but its value is never read.
```

Import it through a non-literal specifier so it stays out of the TypeScript
program and is resolved only at runtime:

```ts
const workpoolTest = '@convex-dev/workpool/test'
const { register } = (await import(/* @vite-ignore */ workpoolTest)) as {
  register: (t: unknown, name: string) => void
}
```

Do **not** relax `noUnusedLocals` to make this go away — it would cost the
whole repo a real check to accommodate one dependency's defect.
`@convex-dev/rate-limiter/test` and `@convex-dev/resend/test` ship the same
shape and happen to be clean, so they are imported normally; if one of them
ever trips the same error, give it the same treatment rather than changing the
compiler options.

## A reasoning model does not answer in a string

`zai-glm-5-3` returns `choices[0].message.content` as an **array of blocks**,
not the string the OpenAI-compatible shape specifies and every other model we
had used sends:

```jsonc
"content": [
  { "type": "thinking", "closed": true,
    "thinking": [ { "type": "text", "text": "…the model reasoning aloud…" } ] },
  { "type": "text", "text": "{\"overallScore\": 71, …}" }
]
```

The envelope parser accepted only `z.string()`, so **every** evaluation failed
with `completion envelope was not understood`. It shipped to production,
because nothing in the unit suite could see it: each test stubs `fetch` with a
hand-written response, and every one of those stubs sent a string. A test
cannot discover that a provider disagrees with its own documented shape.

`answerText` in `convex/lib/ai.ts` now takes either form, and keeps **only the
top-level `text` blocks**. Not the first block, and not all of them joined: the
`thinking` block is the model musing, and it regularly contains JSON-looking
fragments. Feeding those to `JSON.parse` would produce a report nobody wrote,
which is worse than the crash it replaced — `convex/lib/ai.test.ts` puts a
decoy JSON inside the reasoning precisely to pin that down.

**The lesson is the procedure, not the patch.** Before pointing this product at
a model nobody here has called, run it once against the real API and read what
comes back. A temporary `internalAction` calling `complete()`, pushed to the
dev deployment with `npx convex dev --once` and run with `npx convex run`,
costs two minutes and is the only thing that can catch this class of problem.

### Its corollary: reasoning burns the output ceiling

Measured on the same call — a 27-token prompt asking for three fields spent
**2 747 completion tokens**, nearly all of it reasoning the caller never sees.
`MAX_COMPLETION_TOKENS` was 16 000, sized for an answer with no thinking in
front of it. An interview report is a much longer prompt and a much longer
answer, so the ceiling now stands at 32 000 and has to cover both halves.

It is a ceiling, not a reservation: a short answer is billed short, so headroom
is free and a truncation costs the whole job. The API accepts a `max_tokens` of
131 072 on this model without complaint, so there is room above if reports ever
start truncating.

And when one does truncate, the provider says so plainly with
`finish_reason: 'length'` — which `complete()` now checks **before** parsing.
Without it, a cut-off answer surfaced as "model output was not valid JSON" and
sent whoever read `jobLog` hunting for a schema bug that was not there.

## A job board's ad lives in its JSON-LD, not in its markup

"Import a job ad" fetched the page, ran `htmlToText` over it, and refused
anything under 400 characters as `page_too_thin`. That works on a hand-written
ad on a company site and fails on essentially every real job board — Welcome to
the Jungle, Indeed, Workday, most ATS career pages — because they render the ad
in the browser. The served HTML is a nav, a cookie banner and an empty `<div>`.

The ad is still in the response, in a `<script type="application/ld+json">`
block holding a schema.org `JobPosting`. That block is not optional for them:
without it the ad is invisible to Google for Jobs, which is where a board's
traffic comes from. So it is present, complete, and cleaner than the rendered
page would have been — the ad without the chrome.

`htmlToText` drops every `<script>` as its first act, which is right for its
job and threw away the only copy of the ad. `jobPostingText` in
`convex/lib/htmlText.ts` reads the JSON-LD **before** the tags are stripped;
`jobImport.ts` runs both readings and keeps whichever is longer, because a
server-rendered ad has no JSON-LD at all and a client-rendered one has nothing
else.

Two details worth keeping if this is ever touched again:

- The posting can sit inside a `@graph` wrapper or an array alongside a
  `BreadcrumbList`, and `@type` can itself be an array. Walk the document.
- `description` is HTML inside a JSON string, so it goes back through the tag
  stripper. Malformed JSON-LD is skipped silently — there is a second reading
  to fall back on, and repairing a board's broken markup is how an import
  invents a role that was never advertised.

### Its neighbour: Node's `fetch` sends no `User-Agent`

Same flow, different failure. `fetch` in the Node runtime sends no
`User-Agent` header at all, and a good share of job boards refuse an
unidentified client outright. The recruiter then read "that page could not be
read, check the link" about a link that was correct.

The fetch now identifies itself (`InterwBot/1.0 (+SITE_URL)`) rather than
impersonating a browser, and `401 / 403 / 429` gets its own `page_blocked`
code. Some sites bot-wall everything regardless; the point is that the recruiter
is told the site said no, instead of being sent hunting for a typo.

### Its other neighbour: parse work must be linear, not just capped

The fetcher caps a page at 2 MiB; that bounds the transfer, not the parse. A
lazy `open[\s\S]*?close` regex, or a tag class like `[^>]`, rescans to the end
of the input from every unclosed opener — 2 MiB of `<` cost an extrapolated
~30 min of CPU in one action (audit 2026-09-22,
`convex/lib/htmlText.ts:htmlToText:quadratic-regex-over-uncapped-body`).
`htmlText.ts` uses `[^<>]` classes and a single-pass span scan (`spans()`);
`htmlText.test.ts` fails if either is widened back.

Note that `errors.page_unreachable` still offers to let them "paste the text
instead", which no screen in the wizard does. Either build it or drop the
promise — it is copy writing a cheque the product does not cash.

## A deploy key silently overrides `--prod`

`convex env set --prod X y` does **not** write to production when
`CONVEX_DEPLOY_KEY` is present in the environment. The CLI prints one line —
`Ignoring --prod, --preview-name, or --deployment-name flags and using
deployment from CONVEX_DEPLOY_KEY` — and then writes to whatever deployment
that key points at. Exit code 0. Same for `convex env list --prod`, which is
how this was found: it returned the dev variables.

This matters because the key is injected automatically in environments you did
not configure by hand — a Claude Code cloud sandbox, a CI job, anything that
provisions a dev deployment for you. Running `pnpm setup:prod` there used to
stamp `APP_ENV=production`, the production `SITE_URL` and a freshly rotated
`BETTER_AUTH_SECRET` onto **dev**: every dev session invalidated, and every
magic link sent from dev pointing at the production domain. Nothing in the
output said so.

`scripts/setup-prod.mjs` now refuses to start when `CONVEX_DEPLOY_KEY` is set.
Reach for `env -u CONVEX_DEPLOY_KEY pnpm setup:prod`, and apply the same
reflex to any one-off `convex env set --prod` you type by hand: check the shell
first, or read the deployment name the CLI echoes back before believing it.

The general shape: a flag that names a target is a *request*, and an ambient
credential that names a different target wins. Whenever both exist, trust what
the tool says it did, never what you asked for.

## A fresh clone has no `origin/HEAD`, and `/security-review` needs it

`git clone` normally writes `refs/remotes/origin/HEAD`, but the checkout a
Claude Code on the web session starts from does not carry it. Nothing in the
app notices — until a skill asks git what the default branch is.

The built-in `/security-review` opens by listing the branch's commits with
`git log --no-decorate origin/HEAD...`. With the ref missing, git answers
`fatal: ambiguous argument 'origin/HEAD...'` and the skill aborts before
reading a single line of the diff. The failure mode is the bad one: the agent
concludes the skill is unavailable and skips the pass that `CLAUDE.md` § 6
makes mandatory, so the gate has a hole that looks like a clean run.

`git remote set-head origin -a` resolves the default branch from the remote
and writes the ref. It runs in the `SessionStart` hook of
`.claude/settings.json`, ahead of `sync:skills:check`. It belongs in the hook
rather than in a committed file because `origin/HEAD` is a *local* ref — it is
not repository state, nothing on the remote changes when it is set, and no
clone inherits it. Every new container therefore needs it re-applied. The
command is idempotent and costs one `ls-remote`.

Same skill, sibling trap: it reads *commits*, not the working tree. Running it
before committing reviews an empty diff and reports nothing at all, which
reads exactly like a clean pass. Hence the order in `CLAUDE.md` § 6 —
`/simplify` first on the working tree, commit, then `/security-review`.

## A preview deployment is not a staging environment

Convex preview deployments are **deleted automatically after 5 days** (14 on
Professional and above), data included. They are per-branch scratch backends,
and nothing else: a demo you want to show next week, a trial account left with
a client, a set of recordings you expect to find again — none of that survives
in one.

A permanent environment needs a permanent deployment, and Convex gives exactly
one per project: its production. So a staging environment is a **second Convex
project**, whose production deployment is the staging backend — which is what
the Convex docs recommend for this. The asymmetry with the web host is worth
holding onto: a Vercel deployment is stateless, so building one per branch
costs nothing and throwing it away loses nothing; a Convex deployment *is* the
database.

## A preview deployment starts with no environment variables

Convex preview deployments — one backend per branch — do **not** inherit the
production deployment's environment variables. Each one
starts from the defaults registered for the `preview` deployment *type*:

```bash
npx convex env default set --type preview OBJECT_STORE_BUCKET interw-video-dev
npx convex env default list --type preview
```

This is a feature, not a gap, and the reason matters: if previews inherited
production, every branch would mint signed URLs against the production bucket,
and a throwaway branch could read and delete real candidate recordings. The
defaults are where "what the dev environment is" gets written down once.

Two consequences for this repo:

- A new required variable is a **three-place** change: the production
  deployment, the `preview` defaults, and each developer's `dev` deployment.
  Forget the second and previews fail at the first job, on a branch, where
  nobody is watching.
- The frontend does not need to hardcode a Convex URL. `convex deploy --cmd`
  creates the branch's backend and sets **both** `VITE_CONVEX_URL` and
  `VITE_CONVEX_SITE_URL` for the wrapped command — the build log says
  `Running 'pnpm build:app' with environment variables "VITE_CONVEX_URL" and
  "VITE_CONVEX_SITE_URL" set`. So the explicit `VITE_CONVEX_SITE_URL` in a
  Vercel project is only needed where the build does *not* run `convex deploy`.
- What per-branch previews would still need is a `trustedOrigins` that
  accepts branch URLs — see § "`trustedOrigins` holds one origin per
  deployment".

## Convex refuses a production deploy key in a Vercel preview build

Staging here is the production deployment of a second Convex project, and the
obvious wiring is to put that project's production deploy key on the Vercel
branch that serves staging. The build fails:

```
✖ Detected a non-production build environment and "CONVEX_DEPLOY_KEY"
  for a production Convex deployment. This is probably unintentional.
```

`convex deploy` reads `VERCEL_ENV`. Vercel sets it to `preview` for every
branch that is not the project's production branch, and Convex refuses the
pairing — a guard against a feature branch overwriting production, which is
the right default and is not configurable.

The vocabularies do not line up, and that is the whole difficulty:

| | Vercel | Convex |
| --- | --- | --- |
| permanent, real | Production | the project's production deployment |
| per branch, disposable | Preview | preview deployment (deleted after 5 days) |
| local | Development | the developer's own `dev` deployment |

Neither has a "staging" slot. On Convex we build one out of a second project.
On Vercel the slot exists — Custom Environments, which can literally be named
`staging` — but it is a paid feature; on a plan without it the API reports
`accountLimit: {total: 0}`.

So within one Vercel project, a staging branch cannot run `convex deploy`.
Either give staging its own Vercel project whose *production branch* is the
staging branch — which makes the build a production build, and is what both
vendors document — or leave `DEPLOY_CONVEX` off that branch, point
`VITE_CONVEX_URL` at the staging backend by hand, and deploy the backend by
another route. The second works, at the cost of front end and back end no
longer shipping together: a push updates the site and not the functions,
silently.
