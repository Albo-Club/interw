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
   trust : an email code (or the magic link it replaced), OAuth
   (Google/GitHub/…), or email/password with
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
4. **The email code is the way in; a password never is.** Accounts are
   created by the email code (or Google), both of which prove the
   address, so `emailOTP` keeps sign-up on and
   `emailAndPassword.disableSignUp: true` turns password sign-up off. The
   rule this replaces — "magic link must not auto-sign-up, `/register`
   (password + verification) is the only entry" — held while a password
   sign-up was the entry point; with a code as the entry point it is
   inverted. A password-less account is normal now: `signIn.email` answers
   it with the ordinary "invalid email or password", and a password can be
   added through the reset flow, which creates the credential. See
   "Email sign-in: one code, typed or confirmed" below.

### Security coupling

Conditions (1) and (2) are coupled. If you enable account linking but
let one method stay untrusted, an attacker can register
`victim@example.com` with their own password (no verification needed),
wait for the victim to OAuth/magic-link with the same email, and BA
will silently link the attacker's password account to the victim's
session → account takeover.

Verified email closes *that* hole: OAuth refuses to link an unverified local
account (`requireLocalEmailVerified`, default true), and an email code deletes
the unproven credential before verifying (`revokeUnprovenAccountAccess`).

**But a verification link is not proof of the password.** It proves control of
the mailbox, and nothing about who chose the password on the account it points
at. BA's `/verify-email` (1.6.x) flips `emailVerified` and, with
`autoSignInAfterVerification`, signs the clicker in — without revoking an
unproven credential. An attacker who signed up at the victim's address kept a
working password on an identity the victim's own click verified, and could then
accept invitations bound to that address. Same with a change-email link sent to
a victim's address (audit 2026-09-22, `VALIDATION-RESULTS.md` lead 1).
`verificationRequiresCredential` in `convex/auth.ts` closes both: a sign-up
link only redirects to `/login?verifyToken=…`, and the email is verified by a
`/sign-in/email` carrying that token **and** the account's password; a
change-email link completes only for a clicker already signed in to the
account. Never re-enable `autoSignInAfterVerification`, and never redeem a
verification token without the credential. A squatted address is recovered by
forgot-password (which replaces the stranger's password) or an email code
(which deletes it).

The same hook also owns the dead ends. An expired or bad token goes to
`/login?verifyExpired=1`, because BA's own `${callbackURL}?error=` lands on
`/app`, whose guard drops the error on the way to a bare `/login`. `/login`
opened with a `verifyToken` in a browser signed in to *another* account
explains itself instead of bouncing to `/app`, which used to drop the token.
Google on a still-unverified password account is refused by design
(`requireLocalEmailVerified`) and comes back as `?error=account_not_linked`,
which gets its own message (continue with an email code, then Google links).

Every redirect error lands on `/login` with the `redirect` it started with:
Google's `errorCallbackURL` carries it, and `onAPIError.errorURL` sends a
callback that fails before its state is read (bad or missing `state`) to
`/login` rather than Better Auth's bare `/api/auth/error` page.

### TanStack Router JSON-parses search values

`?flag=1` reaches `validateSearch` as the **number** `1`, and `?flag=true` as a
boolean. A `z.literal('1')` fails, and a failing `validateSearch` renders the
route's error screen rather than dropping the param. Type flags for what the
parser produces (`z.literal(1)`), and add `.catch(undefined)` when a malformed
value should be ignored rather than fatal.

### Legacy users

Prod accounts created before this fix have `emailVerified: false` on the BA
side. On the next `signIn.email`, they will be blocked — the `/login` screen
detects `EMAIL_NOT_VERIFIED` and offers "Resend verification email" to
unblock, which keeps their password. Signing in with an email code instead
also works, and deletes that password (announced on screen). No automatic
migration.

For duplicate `users` rows already created in prod, `provisionAppUser` will
converge them to a single row on the user's next login, but the second BA
user remains in the database. Manual cleanup via the Convex dashboard.

## Email sign-in: one code, typed or confirmed

The email method is Better Auth's `emailOTP` plugin (`convex/auth.ts`): a
6-digit code, valid 10 minutes, 5 tries, stored hashed. It replaced the magic
link. The same email carries a button to `/login/code#email=…&code=…`.

### Why a code, and why the link needs a click

Corporate mail scanners (Defender Safe Links, Mimecast, Proofpoint…) open
every link in a message, some in a headless browser that runs the page's
script. A one-time link is spent by the scanner before the person ever sees
it. A code has to be typed; and the link only opens our page with the code
filled in, where nothing happens until a person presses **Confirm** (a POST).
Keep it that way: the link page must never auto-submit, and the code step
auto-submits only on digits a person typed.

### Why the fragment

The address and the code travel after the `#`, which the browser never sends
to a server — not to our proxy, not to Vercel's or Convex's logs, not in a
`Referer`. `src/routes/login_.code.tsx` reads it once, then strips it with
`history.replaceState`. Never move them to the query string. The page's
return URL is not in the email at all: the browser that asked for the code
remembers it (`src/lib/auth-memory.ts`), another device lands on `/app`.

### What Better Auth does with a code (1.6.30)

`plugins/email-otp/routes.mjs`, `signInEmailOTP`:

- **No account** → creates one with `emailVerified: true` and an empty
  name, which is how the UI knows to ask "What should we call you?".
- **Unverified account** → `revokeUnprovenAccountAccess`
  (`db/revoke-unproven-account-access.mjs`) deletes its `credential` account
  and every session, *then* verifies it. That is the anti-squatting fix:
  whoever set a password on someone else's address loses it when the owner
  shows up. Verified accounts are not touched — their password keeps working.
- `atomicVerifyOTP` consumes the code on read; a wrong code puts it back with
  one more attempt counted; after `allowedAttempts` the next try gets
  `TOO_MANY_ATTEMPTS` and the code is gone. An expired code is `OTP_EXPIRED`.
  The identifier is `sign-in-otp-<email>`, so another address's code is just
  `INVALID_OTP`.
- Each send **replaces** the pending code (`resendStrategy` defaults to
  `rotate`) — and it replaces it *before* calling our sender.

### The deleted password is announced, from what the server saw

A person who did choose that unverified password would otherwise find it
silently gone. `revokedPasswordNotice` records, before the code is checked,
that an unverified account holding a credential is signing in (keyed by the
`Request`), and after a successful sign-in adds `passwordRevoked: true` to the
response only if the credential is actually gone. Don't infer it from the
response's `user.emailVerified` (still `false` there: Better Auth returns the
object it read before updating it) — that is an accident of 1.6.30.

### Per-address quotas are charged before Better Auth runs

`perEmailQuota` charges `emailCodeSend`, `passwordResetSend`,
`verificationSend` or `passwordSignIn` in a before hook, for every address,
and refuses with a real 429 (`code: 'RATE_LIMITED'`). The bucket key is an
HMAC of the normalised address under `BETTER_AUTH_SECRET` (`makeSignature`),
so the rate limiter's table — which nothing erases — never holds addresses. It used to happen inside the email senders,
which was wrong three ways:

1. A sender only runs for an address that has an account, so the quota
   refusal told a stranger the account existed.
2. The code endpoint rotates the code before its sender runs, so a refused
   send still replaced the owner's code — an unmetered stream of fresh codes
   to guess at, five tries each.
3. A `ConvexError` thrown inside a Better Auth callback reaches the browser
   as a bare 500 with no code, which the pages read as "sent".

Rule: never call `consumeLimit` (or throw anything but an `APIError`) inside
a Better Auth sender.

### What is switched off

- `disabledAuthPaths`: the plugin's verify-email, reset-password and
  change-email-by-code endpoints. We never mail those codes, and a code
  minted but never mailed is still six digits someone could guess at. The
  hook also refuses any code type but `sign-in`.
- `emailAndPassword.disableSignUp: true`: nobody creates an account with a
  password any more. Against the account-linking rule above: (1) every way in
  proves the address on first use — a code verifies on creation, Google
  returns a verified email — and (2) `accountLinking.enabled` is unchanged.
  Legacy unverified password accounts still complete their old verification
  link through `verificationRequiresCredential`.

## Brute force: the IP is a claim, the account is not

Better Auth's `rateLimit` is per IP, and it takes the IP from a request
header (`@better-auth/core/dist/utils/ip.mjs:201-217`). Whoever sets the
header chooses the bucket. Two ways that went wrong (audit 2026-09-22,
`VALIDATION-RESULTS.md` lead 3):

- The Convex adapter's proxy (`@convex-dev/better-auth/dist/react-start/index.js:38`)
  copies every inbound header, so our `/api/auth/*` forwarded whatever the
  client and the platform left in `X-Forwarded-For`.
- `<deployment>.convex.site/api/auth/*` is public. A request sent straight
  there carries any header its sender likes: a new `X-Forwarded-For` per
  guess meant a new bucket per guess, and unlimited password guesses.

**The per-account limit is what makes it safe.** `/sign-in/email` is charged
in `perEmailQuota` (bucket `passwordSignIn`: 5 at once, then 10 an hour),
keyed on the address, before Better Auth looks anything up. No header moves
it. It counts every attempt, not only failures — a before hook cannot know
the outcome, and a guesser's attempts are failures anyway. The cost: someone
can keep one address's bucket empty and block its **password** sign-in. The
email code is untouched by it, so the owner still gets in.

**The per-IP key now comes from the platform, not the client.**
`src/routes/api/auth/$.ts` drops `X-Forwarded-For`, `X-Real-IP` and
`x-interw-client-ip` from the client and sends the address Vercel's edge
wrote into `X-Forwarded-For` as `x-interw-client-ip`
(`convex/lib/clientIp.ts`); `advanced.ipAddress.ipAddressHeaders` reads only
that header. A name no platform sets, so legitimate traffic lands in its own
bucket whatever Convex's ingress does with `X-Forwarded-For`. Custom headers
do reach Convex HTTP actions unchanged — the Resend webhook's `svix-*`
signature headers depend on it.

**What stays unknown offline**, and why it no longer matters for passwords:

- What Convex's ingress does with a client-supplied `X-Forwarded-For` on a
  direct `.convex.site` request (pass through, append, overwrite). Better
  Auth no longer reads that header at all.
- A direct request can still name any `x-interw-client-ip`, so the per-IP
  rules (sign-in, code sends, reset) remain bypassable from outside the web
  domain. Every endpoint that matters for guessing — password sign-in, code
  sends, reset and verification emails — also has its per-address bucket; the
  code itself allows five tries per code.
- A direct request with **no** client-IP header lands in Better Auth's shared
  `no-trusted-ip` bucket per path. Only direct callers share it: every
  browser request goes through the proxy and carries its own address.
- On a host other than Vercel, whether its proxy overwrites
  `X-Forwarded-For` is that host's contract. Check it before trusting the
  per-IP key there.

Closing the direct path for good means the proxy proving itself to Convex
(a shared secret on both sides, or refusing `/api/auth/*` on `.convex.site`
unless it carries one). Not done: it needs a secret set on both the Vercel
project and the Convex deployment, and the per-account bucket already bounds
guessing.

## Super-admin is the operator's address, not the first sign-up

`provisionAppUser` (`convex/lib/auth.ts`) used to make the first row in
`users` a super-admin. On an empty deployment — a fresh one, or right after
`admin.purgeExcept` — that is whoever reaches the sign-up form first, and the
code flow creates accounts for any address. Now a **new** row is super-admin
only when Better Auth reports its address verified and it equals
`SUPER_ADMIN_EMAIL` (trimmed, lowercased). Unset or empty, nobody is
promoted: fail closed.

- Existing rows are never touched: the flag is set on insert only. Deployments
  that already have their super-admins keep them, with or without the
  variable, and `/app/admin` still promotes others.
- An operator who signed up **before** setting the variable is not promoted
  retroactively: a flag that changes on a later sign-in would be a flag an
  env edit can grant silently. Promote from `/app/admin`, or the dashboard on
  a deployment with no super-admin at all.
- `pnpm run setup:prod` mirrors `SUPER_ADMIN_EMAIL` from dev.

## Invitations no longer pre-verify anything

`/accept-invite/$token` signs the invitee in with the same email-code flow as
`/login`, the address fixed to the invited one. The code proves the mailbox,
so the old `inviteToken` → `databaseHooks.user.create.before` pre-verification
(and its `validateInviteForSignup` query) had nothing left to do and the hook
was removed. Two things from that era still matter:

- **A matching email alone never proves anything.** Pre-verifying an account
  because its address equals a pending invitation would let a stranger
  register the victim's address and have it blessed. Mailbox proof comes from
  something delivered to the mailbox: a code, a link token, an invitation
  token — never from the address itself.
- **The accept effect waits for the sign-in form.** A new account still has a
  name to give after its code signs it in, so the page holds its auto-accept
  (and keeps the form on screen) until the form calls `onDone`
  (`onBusyChange` in `src/components/auth/email-sign-in.tsx`). `/login` holds
  its "already signed in" redirect the same way.

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
trusted-email reasoning applies; add its row to `linked-accounts.tsx`, which
lists only the methods this deployment really offers.

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

### Anti-enumeration on sign-in

Sign-up and sign-in are one flow (`/register` only redirects to
`/login?mode=signup`). Asking for a code answers the same for every address —
Better Auth's `send-verification-otp` stores and sends a code whether or not
the account exists, since sign-up is on — so the "Check your inbox" step says
nothing about who has an account. Keep every refusal on that endpoint
address-independent too: see the per-address quota in "Email sign-in: one
code, typed or confirmed".

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
on it for every path in `rateLimitRules` (`convex/auth.ts`), per IP — an IP
a direct caller can claim, see "Brute force: the IP is a claim, the account
is not". Keys must be real endpoint paths — `convex/authEmailCode.test.ts`
asserts it.

`convex/rateLimiters.ts` (the `@convex-dev/rate-limiter` component) is
*separate* — it covers application-level limits (invitations, chat, and the
per-address quotas on emails and password sign-in, charged by the
`perEmailQuota` hook). Do not
confuse the two : BA's limiter is per IP on the auth HTTP edge, ours is per
key on Convex mutations/actions.

### Password policy (Phase 1)

- BA: `minPasswordLength: 12`, `maxPasswordLength: 128`.
- Zod schemas in `/reset-password` and `/me` mirror the
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

It is validated before it is spliced (`cspOrigin` in
`src/lib/security-headers.ts`): an `https:` origin whose host is only letters,
digits, dots and hyphens, and nothing after it. `new URL()` alone is not
enough — it accepts `https://host;x` and keeps `;x` in the origin, which would
append a directive of the operator's typo. A malformed value is dropped, and
`media-src` falls back to `https:` as if it were unset.

### `img-src` names hosts, and one of them comes from the build

`img-src` used to end in a bare `https:`, which let any image the page was
made to render — model output, above all — call any host with whatever the
URL carried. It now lists what actually serves our images: `'self'`, `data:`,
the **Convex deployment origin** (avatars and org logos resolve to
`<deployment>.convex.cloud/api/storage/…`), the media bucket, and
`https://*.googleusercontent.com` (the avatar Better Auth copies from a Google
sign-in into `users.avatarUrl`).

The Convex origin comes from `VITE_CONVEX_URL`, **inlined at build time** in
`src/start.ts`. A build without it ships a policy that blocks every avatar and
logo — `pnpm test:smoke` fails on that. If the deployment is ever put behind
a Convex custom domain, `ctx.storage.getUrl` returns that domain and it must
be added here. A new image source (another OAuth provider's avatars, images
from the bucket) is a capability: add its host in the same PR, with an
assertion in `security-headers.test.ts` on the URL it needs to load.

## A return-URL search param needs the URL parser, not a regex

`/login` takes `?redirect=` and, after a successful `signIn.email`, calls
`window.location.replace(redirect)`. The param was typed `z.string().optional()`,
so `/login?redirect=https://evil.com` was an **open redirect**: the victim signs
in on our real domain with real credentials and gets handed to the attacker at
the exact moment they have proven they trust the page. Better Auth was no help
here — `signIn.email` never receives a `callbackURL`, so BA's `trustedOrigins`
check (`convex/auth.ts`) never runs. Only the redirects *we* navigate to
ourselves are exposed.

Fixed by `src/lib/safe-redirect.ts`, applied in `/login` (and `/register`,
which forwards it there) and to the return URL the code link page reads back
from storage.

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
- The `/app` guard is the one place that produces `?redirect=`: bounced to
  `/login` without a session, you come back to the page you were on. Every
  other occurrence is externally supplied and only *propagated* (Google's
  `callbackURL` / `errorCallbackURL`, the code link's remembered return URL).

## Deploys are wired into the Vercel build

One Vercel project per environment (setup and env vars: README § "Deploying:
staging and production"). Vercel installs with the pnpm named in
`packageManager`, then runs the `build` script, which branches on
`DEPLOY_CONVEX`:

```
DEPLOY_CONVEX=true  →  npx convex deploy --cmd-url-env-var-name VITE_CONVEX_URL \
                                          --cmd 'pnpm build:app'
otherwise           →  pnpm build:app          (vite build)
```

`build:app` does not type-check: `pnpm lint` runs `tsc`, and running it twice
cost ~20 s of every CI run for nothing new. The consequence is that a type
error no longer fails a Vercel build — CI's `check` job is the gate, so a
branch that deploys must be one whose CI is green.

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

### Node has one pin: `engines.node`

Vercel builds on `engines.node` (it overrides the project's own setting) and
CI's `setup-node` reads the same field via `node-version-file: package.json`.
Don't add an `.nvmrc` or a `node-version:` in `ci.yml`: a second pin is how CI
ran Node 22 while production built on 24.

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

## Agent worktrees sit inside the repository

Claude Code checks each agent out under `.claude/worktrees/<name>/` — a full
copy of the repository, inside it. Two globs then reach every copy: `tsc`'s
`include: ["**/*.ts", …]` and `eslint .`. With a handful of agents running,
`pnpm lint` in the main checkout linted every one of them and ran out of
memory, and `tsc` reported each type error once per copy.

Both ignore the directory now (`globalIgnores` in `eslint.config.mjs`,
`exclude` in `tsconfig.json`). The trap in the second: setting `exclude`
**replaces** TypeScript's default instead of extending it, so `node_modules`
has to be listed again or `tsc` walks into it. Vitest is unaffected — its
`include` is rooted at `src/` and `convex/`. A new tool that globs from the
repository root needs the same exclusion.

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
  defeats any lockfile hash: the hash covers the pointer, never what it
  fetches.

### Why we deleted rather than froze

Freezing at `ec1e6ba` would have kept the depth, but frozen docs rot, and the
rot would be invisible. Deleting is safe because **the vendored skills were
never the freshness channel** — see `CLAUDE.md`, "Convex knowledge comes from
three self-refreshing channels". `guidelines.md` is refreshed by
`npx convex ai-files update` and outranks skills by our own rule; the Convex MCP reads the
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
`convex/auth.ts` loads `emailOTP()` (it loaded `magicLink()` when this was
written), so this repo sits squarely in the blast radius — and because it is a template, every project forked from it is born
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
at Claude Code startup. The `skills` CLI (`skills-lock.json`) is only for
library skills that upstream does **not** ship as a Claude Code plugin
(Better Auth, TanStack, …). Installing Resend there too would duplicate the
skills (plugin cache *and* `.agents/skills/`)
and double the update machinery — so we deliberately don't. Let the
marketplace own Resend.

## Resend is a US processor, and moving it to the EU is undecided

Every other candidate-data processor is European (Mistral, the Scaleway
bucket, Convex in EU West); Resend, which receives the address of every
candidate it invites, is not. The move (audit C6.5) has **no decision
yet**. Its cost is not an env var: `@convex-dev/resend` is a Convex component,
so switching to an EU sender (Scaleway TEM, Brevo) means replacing the
component — sending, the erasure hook on its tables (§ "Components keep their
own copies of candidate data"), the 30-day cleanup cron — and re-wiring the
delivery webhook (`/resend-webhook`, `RESEND_WEBHOOK_SECRET`). Decide it
explicitly before the processor list is published; don't drift into it.

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

`SITE_URL` is the Convex env var that builds every email URL (sign-in code
link, invitation accept, change-email verification, delete-account confirm) and
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

## Trade-offs vs the original brief

Choices that diverge from the product brief the template was built from (the
brief itself is not in this repository), with rationale.

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
  Sentry-on-Convex would need a fetch-to-envelope helper. What the front-end
  sends is in § "Sentry collects errors only".

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

"Password changed" is sent **by the server**, never by the page that made the
change: a client-fired notice is skipped by anyone calling the API directly,
and a public "notify me" mutation cannot tell a real change from a replay.
`notifications.passwordChanged` (internal, per-user `passwordChangedNotify`
bucket, logs instead of throwing past it) is reached from three places:

- `/change-password` — an `after` hook in `accountLifecycle`
  (`convex/lib/accountLifecycle.ts`), which skips a failed attempt by checking
  `isAPIError(ctx.context.returned)`: after-hooks run on errors too.
- `/reset-password` — `emailAndPassword.onPasswordReset`. BA 1.6.30 **does**
  have this post-reset hook (`api/routes/password.mjs`, called after the new
  hash is stored, before `revokeSessionsOnPasswordReset`); an earlier version
  of this section said it did not.
- `users.setPassword` — with `added: true` ("a password was added").

**NewDeviceEmail** is not implemented: detecting
"new device" requires storing UA fingerprints in our schema (BA's component
tables aren't queryable from `ctx.db` directly). Tracked as Phase 3 work
behind a dedicated PR — needs a `deviceFingerprints` table + a session-create
hook + an action to send the email.

## Account lifecycle: what Better Auth 1.6.30 leaves to us

Each of these cost an audit finding; the fixes live in
`convex/lib/accountLifecycle.ts` (a local BA plugin, tested on the memory
adapter in `convex/accountLifecycle.test.ts`) and `convex/users.ts`.

- **`freshAge` guards almost nothing.** Only `/list-sessions` and
  `/unlink-account` use `freshSessionMiddleware`; change-email,
  change-password and delete-user use `sensitiveSessionMiddleware`, which
  checks the session exists, not its age. The flip side: **the Sessions tab
  fails with `SESSION_NOT_FRESH` for any sign-in older than an hour** — the
  common case. `ActiveSessions` renders a "sign in again" state for it rather
  than a skeleton that never resolves. `setPassword` is server-only and has no
  freshness check either; `users.setPassword` adds one.
- **Both email-change links return to the same `callbackURL`.** BA reuses the
  approval link's callback for the confirmation link, and stores nothing
  queryable in between. So the step lives in `userPrefs.emailChange`
  (never on the hot `users` row): `approve` from an `after` hook on
  `/change-email` — recorded even when BA silently sends nothing because the
  address is taken, so the profile cannot be used to probe addresses —
  `verify` when `sendVerificationEmail` receives the account with the new
  address swapped in (`users.recordEmailChangeApproved`), `done` from
  `syncBetterAuthUser`. The landing on `/app/me?from=email-change` reads the
  step to say which link just worked.
- **`/delete-user/callback` answers JSON on every failure.** Opened without a
  session it returns `FAILED_TO_GET_USER_INFO`; a bad token or a throwing
  `beforeDelete` is JSON too. A `before` hook resolves each case to
  `/account-deletion?status=…` first, reading the token with
  `findVerificationValue` (not consuming it, so the link still works after
  signing in). Its default expiry is **24 h**, not the hour our copy promised:
  `deleteTokenExpiresIn` is now set.
- **Deleting a sole owner orphaned the organisation.** `cascadeDelete` throws
  `sole_owner` (the last line of defence — it runs inside `beforeDelete`),
  `/delete-user` refuses with `SOLE_OWNER` before mailing, and `/app/me` lists
  the organisations. The way out for a solo owner is to delete the
  organisation first (§ "Deleting an organisation"): one being deleted no
  longer counts as sole-owned.
- **Deleting the last super admin orphaned the platform.** Same three layers
  as `sole_owner`: `cascadeDelete` throws `last_super_admin` (the code
  `admin.setSuperAdmin` already uses for a self-demotion), `/delete-user`
  refuses with `LAST_SUPER_ADMIN` before mailing, the link's callback lands
  on `blocked` for someone who became the last one meanwhile, and
  `accountDeletionBlockers.lastSuperAdmin` disables the button on `/app/me`.

## A removed member keeps their credit, not their creator rights

Removing someone from an organisation deletes their membership, their team
rows and their report share links (`revokeMemberGrants`), never the ids that
credit their work (`projects.createdBy`, `sessions.recruiterDecisionBy`,
`decisionEvents.actorId`, `invitations.invitedBy`, …). Screens resolve those
ids through `memberName` (`convex/lib/memberName.ts`), which keeps the name
and flags `removed`, and render them with `src/components/MemberName.tsx`;
a deleted account has no name left and reads "Former member". A new screen
that credits someone goes through the same pair rather than reading `users`
itself. Authorisation does not read that flag, nor `createdBy` itself: the
creator's seat on the team is a `projectShares` row (audit T17-2), deleted
with the others, so a creator re-invited as a plain member gets `not_found` on
their own roles until someone puts them back on the team. Credit survives
removal; rights do not.

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

## Bumping a SHA-pinned GitHub Action

Every `uses:` in `.github/workflows/ci.yml` names a full commit SHA with its
release as a trailing comment (why: the comment at the top of the file). What
a retagged action could reach there is the `e2e` job's `CONVEX_DEPLOY_KEY`.

To bump one by hand, resolve the tag to the commit it points at. For an
*annotated* tag that is the `^{}` line, not the tag object above it:

```bash
git ls-remote https://github.com/pnpm/action-setup refs/tags/v4.4.0 'refs/tags/v4.4.0^{}'
# a15d…  refs/tags/v4.4.0        <- the tag object: not this one
# fc06…  refs/tags/v4.4.0^{}     <- the commit: pin this
```

A lightweight tag prints a single line, which is the commit. Replace the SHA
**and** the comment in every job that uses the action — a comment that
disagrees with its SHA is worse than none. Renovate's `github-actions` manager
reads this `@<sha> # vX.Y.Z` form and bumps both together once the app is
installed. The pins were taken from what each major tag (`@v4`) resolved to on
the day, not from the newest release, so pinning changed no behaviour — which
is why `pnpm/action-setup` sits on v4.3.0 although v4.4.0 exists.

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
Conventional Commits discipline. Interw cuts no versioned releases at all —
see `CHANGELOG.md`.

## Skills: the standard `skills` CLI, and why Convex rules load via `convex/CLAUDE.md`

**The CLI replaced a 399-line in-house sync script** (`scripts/sync-skills.mjs`,
with its own lock format, `--verify` / `--check` modes and two CI jobs). The
trigger was a collision: `npx convex ai-files update` shells out to the same
`skills` CLI and writes a `skills-lock.json` in *its* format, so running
Convex's own tooling would have clobbered ours. Git and PR review now do what
`--verify` did (a hand edit shows in the diff).

Traps it leaves:

- **`skills check` is not a check.** It is an alias of `skills update`
  (same code path) and rewrites `.agents/skills/`. The `skills-drift` CI job
  therefore runs the update and fails on the resulting diff, and the
  SessionStart hook does not run it at all — a session would otherwise start
  with upstream changes silently staged into whatever PR is open. The earlier
  weekly cron + auto-PR is not coming back either: Actions cannot open PRs
  that trigger `on: pull_request` without a PAT, and crons on idle repos stop.
- **The layout is keyed on `.agents/` existing.** `skills update` re-adds every
  skill without the `--agent` / `--copy` flags it was installed with, and
  writes the canonical layout (`.agents/skills/` + `.claude/skills/`
  symlinks) whenever `.agents/` exists — even empty. A tree installed any
  other way flips layout on the first update and turns `skills-drift` red.
  Install with the Add command in `CLAUDE.md` § Skills and the layout never
  moves.
- **`web-design-guidelines` stays out of the CLI.** The only installable
  version (`vercel-labs/agent-skills`) is a 1 kB wrapper telling the model to
  fetch the real rules from `web-interface-guidelines@main` at run time:
  unpinned, unreviewed, a network call and a prompt-injection surface on every
  use. So `.claude/skills/web-design-guidelines/SKILL.md` is a committed copy
  of that repo's `AGENTS.md` with skill frontmatter on top, not in
  `skills-lock.json`. To refresh: diff it against upstream `AGENTS.md`, read,
  paste. Nothing watches it — that is the price of not fetching at run time.

**Convex rules used to be advisory, and were skipped.** The pointer to
`convex/_generated/ai/guidelines.md` lived in `AGENTS.md`, which Claude Code
does not read when a `CLAUDE.md` exists. `convex/CLAUDE.md` now `@`-imports the
guidelines, and Claude Code loads a subdirectory `CLAUDE.md` as soon as a file
in that directory is read — deterministic, unlike a skill's description
winning a routing decision. `convex ai-files update` also writes a managed
section at the end of the root `CLAUDE.md`; leave it, removing it only makes
the next update re-add it. `convex.json` → `aiFiles.skills.agents: []` stops
that same command from installing `get-convex/agent-skills` (see "Convex skills
were pruned").

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
3. **Loaded on demand.** `AiPanelHost` imports the panel with `React.lazy`
   and renders nothing while it is closed (the default), so streamdown's
   131 KB gzip stay out of the recruiter layout until the panel opens
   (474 → 301 KB gzip for the layout's static closure). A static import of
   anything under `src/components/ai/` or `ai-elements/` from a layout undoes
   that; `AiPanelHost.lazy.test.ts` fails if it happens.
4. **Links lead into the app only.** `allowedLinkPrefixes` (rehype-harden,
   reached through `defaultRehypePlugins.harden`) is the app origin, and the
   `a` renderer re-checks every href, because harden passes `mailto:`,
   `xmpp:`, `irc:` and `blob:` through whatever the prefix list says. There
   is no `allowedLinkPrefixes` prop on `<Streamdown>` in 2.5 — the options
   belong to the harden plugin entry.

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

Refresh the Convex AI guidelines in the same PR: `npx convex ai-files update`
(`convex dev` warns when they are stale). Nothing else regenerates them.

A `convex` bump also rewrites `convex/_generated/server.d.ts` (1.44 added the
typed `env` export carrying `CONVEX_CLOUD_URL` / `CONVEX_SITE_URL`). Commit it
with the bump: `pnpm codegen:api:check` only guards `api.d.ts`, so a stale
`server.d.ts` sails through CI and reappears as a phantom diff for whoever
next runs `convex dev`.

`.mcp.json` pins the same version for the Convex MCP server
(`npx -y convex@<version> mcp start`). Renovate moves it with `convex` (the
`customManagers` regex in `renovate.json`); a bump by hand must move it in the
same PR. It is an exact `npx` pin rather than `pnpm exec convex` because
Claude Code starts MCP servers when a session opens, before anyone has run
`pnpm install` on a fresh clone, and `pnpm exec` finds nothing without
`node_modules`. It is not `@latest` because that fetched
and ran the newest registry release on every start, on machines holding
Convex credentials — never the version the lockfile had been reviewed at.

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

## Components keep their own copies of candidate data

`@convex-dev/resend` stores recipient, subject and the full body of every email
(`emails` / `content` / `deliveryEvents`) and forgets only when the app
schedules `cleanupOldEmails` / `cleanupAbandonedEmails` — the README says so,
and nothing did until `convex/crons.ts` `cleanupResend` (7 days after the
outcome, 30 days absolute). 0.2.8 has no per-email delete, so erasure of that
copy cannot be immediate; and once a component row is gone, a late webhook
event for it is ignored and never reaches `emailLog`.

`@convex-dev/agent` threads hold tool results — and the answers written from
them — where the app cannot search. So the candidate-reading tools record a
`chatThreadSessions` row in the same transaction as the read, and
`purge.deleteChildRows` deletes those whole threads. Any new tool that returns
candidate data must record the same row, or its output survives erasure.
Threads created before this change carry no row, so erasure cannot find them;
they are purged once by `migrations.purgeLegacyAssistantThreads`, an hourly
cron that fixes its cutoff at its first run on each deployment (on staging,
that also takes the threads created between the two changes — deliberately),
deletes every thread older than it with its `chatThreadSessions` rows, and
sets `doneAt` after a full pass finds none left. The component lists no
threads globally: the pass walks `users.listUsersWithThreads`, which reads the
component's own table, so a removed member's scope is reached too; only a
thread with no `userId` is invisible to it, and the app never creates one.
This is the owner's one-off retention decision, not a pipeline catch-up
script: it repairs no lost step, and once `doneAt` is set on every deployment
the function, its cron and the `migrations` table can be deleted.
`chat.listMessages` answers an empty page for a thread that no longer exists,
because erasure may delete a thread a recruiter has open.

## Deleting an organisation: freeze, wait out the upload URLs, then erase

`organizations.requestDeletion` erases nothing itself. It sets
`organizations.deletingAt`, mails the members while the memberships still say
who they are, and schedules `orgErasure.step` **`WRITE_URL_TTL_SECONDS`
(15 min) later**. Both halves are load-bearing:

- **Freeze before collecting.** From `deletingAt` on, `requireOrgMember`
  throws `org_deleting` (so every recruiter function, the chat included),
  `users.me` drops the organisation (the layout then renders "redirecting"
  instead of children whose queries now throw), `evaluateSessionGate` reads
  `closed` for every candidate link, `resolveShare` answers `not_found`, and
  invitations stop resolving. Erasure collects keys from rows; anything that
  could still add a row or a key while it runs would outlive it.
- **The wait.** A PUT URL signed a second before the freeze still works for
  its full TTL. The segment row naming it was written before the upload, so
  once those URLs have expired the key set in the database is final — collect
  earlier and a late answer lands in a bucket nothing points at.

Then one bounded phase per invocation, rescheduling itself: sessions through
the purge core (`purge.eraseSession`: objects, then
rows via `purge.deleteSessionRecords`, reason `org_delete` — never a parallel path),
project media then the role rows, assistant threads by `${orgId}:` scope
prefix (a thread that never read a candidate has no `chatThreadSessions` row
for the session core to find), invitations / report shares / email and job
logs, and last the memberships, the logo (through `release`) and the
organisation row. The row with `deletingAt` is the durable state: `step` on an
organisation that is gone, or was never frozen, does nothing.

What deliberately survives, or cannot be reached:

- **`purgeLog` rows stay**, one per candidate, with an `orgId` that now points
  at nothing. The register is the proof the erasure happened; it holds hashes,
  not addresses.
- **Resend's copies** of every email sent for the organisation, including the
  deletion notice, go with the `cleanupResend` cron (§ "Components keep their
  own copies of candidate data"), within 30 days.
- **An upload whose attach was refused by the freeze.** Project media and CVs
  record their key on attach, after the PUT; an attach refused by
  `org_deleting` leaves an object no row names, as a failed attach always
  has. The keys are deterministic (`orgs/<orgId>/…`), which is why the manual
  check in `TESTING.md` L12 looks at the prefix rather than the rows.

Convex never retries a scheduled action, so `step` catches, logs
`[org-erasure] failed` and tries the same phase again five minutes later. An
erasure that cannot finish shows up as that line repeating, with the
organisation still frozen — never as a half-erased organisation somebody can
still open.

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

The cost is that the client must send **exactly** what was signed. The XHR
in `src/lib/media/upload.ts` does this automatically for a `Blob` — it sets
`Content-Length` from `blob.size` and takes `Content-Type` from the header you
pass. A hand-rolled
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

**The risk is Safari, iOS above all.** WebKit has a history of misbehaving
with two `MediaRecorder`s live on the same tracks: one of them returns an
empty blob, `stop()` never fires its final `dataavailable`, or `start()`
throws `InvalidStateError`. Nothing in CI catches it — the e2e WebKit project
runs desktop WebKit on a fake device, not iOS Safari on a real camera — so the
only guard is TESTING.md IB10 played **on an iPhone** after every change to
`src/lib/media/recorder.ts` or any iOS major. The symptom to look for: an
answer with an audio object and no video (or the reverse) while the screen
said it saved normally, or a "Saving…" that never ends.

If it breaks, the fallback is one recorder: record video-with-sound only, and
extract the audio track server-side at transcription time (the transcription
job would take the video key and demux before calling the provider). That
costs a larger download per transcription and a demux step, which is why it is
not the default.

## An answer is saved when its audio lands; the video is extra

The candidate runner uploads the audio, calls `markSegmentUploaded`, and only
then uploads the video. The audio is what gets transcribed and assessed, so
it alone decides whether an answer exists: a 40 MB video failing on a train
after the 1 MB audio arrived used to discard the answer, although everything
the report needs was already in the bucket. A failed video is logged as an
`upload_failed` event whose detail starts with `video:`, and announced.

The trap is on the reading side: such a segment still carries its `videoKey`
(written before the upload, which is what keeps erasure exact), and no object
sits behind it — a signed URL for it is a 404 that looks like a signing bug.
So a key is not proof of an object: `reserveSegment` writes
`videoUploaded: false` next to the key, `markVideoUploaded` flips it once the
PUT succeeded, and every player picks its source through `playbackMedia`
(`convex/lib/objectStore.ts`) rather than `videoKey ?? audioKey`. Rows older
than the flag have it absent and are taken as uploaded.

## An answer is copied to IndexedDB while it records

`SegmentRecorder` starts both recorders with a 2 s timeslice and hands every
chunk to `onChunk`; the runner writes it to `src/lib/media/takeStore.ts`
(IndexedDB `interw-takes`). A reload finds the take for the question it
resumes on and sends it — the same attempt, not a second one. The in-memory
chunks are still what a normal `stop()` uploads, after the final flush: the
IndexedDB copy is only ever read after a reload.

Traps worth knowing:

- **Best effort, never blocking.** Safari private browsing and a full disk
  refuse IndexedDB; every write is `fireAndForget`, and recording works from
  memory exactly as before. Do not make a write awaited on the recording path.
- **It is candidate video on the candidate's device.** A take is deleted when
  the server holds the answer, on skip, on finish, when the candidate erases
  their data from this browser, and after 24 h whoever it belongs to (a shared
  computer must not keep it). Erasure from anywhere else cannot reach it —
  that is why the 24 h cut exists.
- **A crashed take has no final flush.** Concatenated WebM/fMP4 chunks still
  play; the last ≤ 2 s are lost, and the duration is the time between the
  take's start and its last chunk.
- **A recorder with no audio after 6 s never will.** The tick fires
  `onFailure`, the runner stops the take, and the empty-take path offers to
  record again — seconds in, instead of after two minutes.

## Video is recorded as MP4 wherever the browser can

`VIDEO_MIME_PREFERENCES` puts H.264/AAC MP4 first (Chrome and Edge 126+,
Safari) and keeps WebM only as the Firefox branch. Two reasons, both on the
recruiter's side, not the candidate's:

- **MediaRecorder's WebM has no duration and no cues.** The player reports an
  unknown duration and seeks wherever it guesses, which quietly breaks "jump
  to the quote". Its MP4 is fragmented, which carries its own timing.
- **WebM playback on Safari, iOS above all, varies by version.** A recruiter on
  an iPhone could not always watch an answer recorded in Chrome.

The **audio** file is deliberately left alone: WebM/Opus on Chrome and
Firefox, M4A on Safari. It is what gets transcribed, and the transcription
path already takes both — changing it would risk the answer for no gain.
The transcription call labels the file with `mimeTypeForKey(key)`; it used to
hard-code `audio/webm`, which was wrong for every Safari answer.

Firefox answers therefore stay WebM, with the seeking problem above, until
something re-muxes them server-side. Plain `video/mp4` stays in the list
after the codec-qualified entries for a Safari that answers no codec query.

## E2E fixtures are opt-in per deployment

`convex/e2e.ts` holds the browser test's seed (`seedE2eSession`) and its
database check (`e2eSessionState`). They are internal functions, so only a
deploy key reaches them — but a deploy key is exactly what a production
deploy has too, and `npx convex run e2e:seedE2eSession` against production
would create a fake org and a real outgoing email.

So each fixture refuses unless the deployment's Convex env has
`E2E_FIXTURES=enabled`. Set it on dev and on staging, never on production.
The gate is an explicit opt-in rather than an `APP_ENV` check because staging
— where CI runs the browser test — runs with `APP_ENV=production` (see
README § deployment); an `APP_ENV === 'development'` gate would have turned
the e2e job red on staging and left nothing to tell prod from staging.

The refusal is a plain `Error` with an English message, not a `ConvexError`
code: nobody but a developer ever sees it, and a code would need user-facing
copy in `errors:codes`.

## Headless Chromium in the cloud sandbox cannot reach a Convex deployment

Two things stand between a Playwright run in a Claude Code cloud session and
a real deployment, and neither is in this repo:

- The browser NSS store (`~/.pki/nssdb`) starts empty, so every HTTPS request
  through the session's TLS-terminating proxy fails with
  `ERR_CERT_AUTHORITY_INVALID`. Importing `/root/.ccr/agent-proxy-ca.crt` with
  `certutil` (package `libnss3-tools`) fixes HTTPS.
- Chromium's WebSocket upgrade to `wss://*.convex.cloud` then fails with
  `400`, whether it reaches the proxy on its own or through
  `--proxy-server` — while `curl --http1.1` and Node's `WebSocket` get `101`
  through the same proxy, with the same headers. The Convex client has no
  HTTP fallback, so the page never loads its data.

Do not spend the afternoon on it: run the candidate e2e in CI, where the
runner reaches the deployment directly. Locally, `pnpm test` covers the
reducer, the recorder and the server; the browser path needs CI or a phone.

## Playwright's Linux WebKit cannot record: the e2e runs on macOS

Playwright's WebKit for Linux (WebKit 26.6, Playwright webkit v2359 on
`ubuntu-latest`) has **no `MediaRecorder` at all**: `page.evaluate` throws
`ReferenceError: Can't find variable: MediaRecorder` (measured on CI,
2026-09-25). The candidate page then detects no recording format and shows
"This browser can't record video interviews", so no `<video>` is ever
rendered and `e2e/interview.spec.ts` fails at its first preview check with
"element(s) not found". No fake device, `getUserMedia` stub or audio-only
path can help: nothing can be recorded. Safari has had `MediaRecorder` since
14.1, so this is the Linux build, not the product.

The CI `e2e` job therefore runs on `macos-latest`, where Playwright's WebKit
records, and both browsers run in that one job: split into a Linux and a macOS
job, the two took two places in the `e2e-staging` concurrency group and a run
queued on `main` cancelled the waiting one. Running `--project=webkit` on a
Linux machine reproduces the failure; it does not prove a regression.

Only two branches of the device check render no `<video>`: a browser that
encodes no format (above), and a camera that failed as busy or missing while
the microphone worked ("Audio only — your camera isn't available"). A refused
permission keeps the `<video>` on screen, so "not found" never means "no
permission". To tell them apart, read the page snapshot in the report's
`error-context.md`.

## The candidate surface switches the shared i18n instance

`useCandidateLanguage` calls `i18n.changeLanguage(project.language)` on the
client's one instance, and does not write the `lang` cookie — the language
belongs to the link, not to the visitor. A recruiter who opens a candidate
link and then navigates back into `/app` in the same tab keeps the role's
language until the next full load. Harmless, and cheaper than a second i18n
instance for the candidate bundle.

## Seeking a `<video>` before `loadedmetadata` is silently ignored

Setting `video.currentTime` before metadata has loaded does nothing — no
error, no warning — and the video plays from the beginning. This is how
"jump to the quote" quietly becomes "plays from the start", which reads as a
broken feature rather than a race.

`AnswerPlayer` waits for `readyState >= 1`, or listens once for
`loadedmetadata`. It also carries a **nonce** on the seek cue, because
clicking the same quote twice must replay it and a plain
`{ segmentId, seconds }` object would compare equal.

## Para-verbal analysis was removed

Reports used to carry six "delivery" figures (speaking rate, hesitation,
silence, time used, consistency, speaking time), computed from the transcript's
timestamps by a `convex/lib/paraverbal.ts` that no longer exists. They were
retired on 2026-09-24 (audit 2026-09-15, Pipe M9): nothing computes, writes or
reads them any more, and neither the recruiter page nor a share link shows them.

Deterministic was not the same as right. The audit found the rate divided by
recording time rather than speaking time, silence before the first word never
counted, a perfect "pauses" score on a transcript with no timings at all, two
dimensions scoring the same quantity, and a hesitation list full of ordinary
words (`genre`, `enfin`, `actually`) applied regardless of the interview
language — penalising registers of speech, which is a fairness problem in a
hiring report, not a rounding one. Fixing all of that would have produced
better-computed figures about how someone talks, and nobody could say what a
recruiter should do with them. Removing them was the product call.

Traps if it ever comes back:

- `reports.paraverbal` is still in `convex/schema.ts`, optional and loosely
  typed, only so reports written before the removal keep validating. Do not
  read it: the values are the flawed ones above. Drop it after a migration has
  cleared it from existing rows.
- `saveReport` omits the field from its `report` validator, so a new write
  fails loudly instead of reviving it.
- The stack still has no audio-capable model. A "confidence" or "vocal warmth"
  score would be an invention dressed as a measurement.

What stays is the rule it taught, in `CLAUDE.md` § Access control: a measurement
never depends on an argument. The answer length served to the recruiter's page and
used to anchor quotes is `segments.measuredSeconds`, written by `saveTranscript` from
the provider's `usage.total_seconds` (fallback: the end of the last timed word;
else absent). `segments.durationSeconds` is what the candidate's browser
reported: a clamped display hint that nothing in the report may read. It used
to feed the delivery figures and every quote anchor — the person being assessed
chose their own measurement (audit 2026-09-22,
`convex/pipeline.ts:reportInputs:candidate-reported-durationSeconds-in-report`).

## A role's team decides who sees it and who is mailed

Since 2026-09-24 (audit T04, decision 3) every role has a **team**: its creator
plus the colleagues they tick. The team is the whole visibility model inside an
organisation:

- **Sees the role**: the team, plus every org admin and owner. Anyone else gets
  `not_found`, never "forbidden" (`canSeeProject` / `filterVisibleProjects` in
  `convex/lib/projectAccess.ts` — every project read goes through them).
- **Is mailed "report ready"**: the team only, membership re-checked at send
  time. Admins and owners see every role but are mailed only about the ones
  they are on. The old rule mailed up to 200 members of the org per report.
  One exception: when nobody on the team is still a member (a creator who
  left alone on their role), the admins and owners are mailed instead, so a
  report never lands with nobody told.
- **Edits the team**: the creator, an admin or an owner
  (`requireProjectOwnerOrAdmin`), at creation or from the Team dialog.

Traps:

- **The creator is a row, and `createdBy` grants nothing.** `projects.create`
  writes the creator's seat; `setTeam` never drops it, so the person who
  opened the search cannot be unticked, but removal from the org takes it like
  any other (T17-2 — `createdBy` used to be the seat, and survived removal).
  Owner tier (`requireProjectOwnerOrAdmin`) is an admin/owner, or the
  `createdBy` member *while seated*: it runs after `requireProjectAccess`, so
  an unseated creator never reaches the comparison. Roles from before carry
  their seat from the one-off `migrations.backfillCreatorSeats`; until it has
  run on a deployment, plain-member creators do not see those roles.
- **The table is still called `projectShares`.** Renaming a Convex table is a
  copy migration. The rows of the former "restricted" roles already meant
  exactly "named colleagues", and a former "open" role had none — so the
  existing data *is* the team, with no migration, lazy or otherwise.
- **`projects.restricted` is legacy and read by nothing.** It stays optional in
  the schema only because existing rows carry it. A role saved as "open to
  everyone" is now visible to its creator, admins and owners only — accepted
  before launch. Never read the flag again; drop it once a migration has
  cleared it.
- **`setTeam` replaces the whole list.** A client that sends it before loading
  the current team wipes it; that is how the old dialog de-restricted a
  confidential role on "open, then Save" (B8). The dialog seeds from
  `projects.team` and cannot save until it has. The list is capped at 100
  (`team_too_large`).
- **Leaving revokes the grants**, in one helper (`revokeMemberGrants`):
  `removeMember` drops the person's team rows in that org and revokes the
  report share links they created there; `users.cascadeDelete` does the same in
  every org. A share link acts for whoever made it, so it must not outlive
  their membership (h03).
- **Leaving one team is a smaller leaving** (`leaveTeam`, used by both
  `setTeam` and `revokeMemberGrants`): the person's report links on that role
  are revoked, and `purge.eraseRoleThreads` erases their assistant threads
  that read its candidates, found through `chatThreadSessions` like erasure
  finds them. An admin or owner still sees the role by rank and keeps both.
  Threads that never read a candidate carry no row and stay: `listRoles`
  output (titles and counts) is not tracked.
- **New slugs end in six random characters** (`uniqueSlug`, T17-3). Slugs are
  unique across the org, hidden roles included, so a counter (`-2`) told a
  member that a hidden role of that title existed. Never derive a suffix from
  what else is taken.

## A role's intro is a video, or nothing

Decision n° 1 of 24/09: the intro modes are `none` and `video`. The written
and audio intros are gone from the selector and from `projects.update`, and
`requestIntroUpload` only issues a slot for a video type — without a camera
the take is refused, never saved as audio. A role with no intro, or in video
mode with nothing recorded, sends the candidate from the device check straight
to question 1 (`opensOnIntro` in `src/lib/interview-machine.ts`): an intro
screen with nothing on it was a dead end.

**The trap: `text` and `audio` are still in the `projects` table's validator.**
Narrowing a stored union before the rows are rewritten fails the schema check
on push — same widen-then-narrow rule as the hot `users` row above. So:

- the argument and return validators use `introModeValidator` (`none | video`);
  the table uses `storedIntroModeValidator`, which also admits the two retired
  literals;
- every read goes through `effectiveIntroMode` (`convex/lib/candidateView.ts`),
  which reads a retired mode as `none` — nothing waits on the migration;
- `internal.media.migrateLegacyIntroModes` rewrites those rows (and releases
  an audio intro's object). It is **not** run by any deploy: run it once per
  deployment, then drop the two literals from `schema.ts` in a later deploy.
  `introText` is kept, read by nothing, until then.

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

### The job never learns its own attempt number

`@convex-dev/workpool` (0.4.x) tracks attempts in its own `work` table and
passes the number to its internal wrapper, but not to the action it runs: the
action receives exactly the args it was enqueued with, and not its `workId`
either. So `jobLog.attempt` cannot be "the pool's number". It is counted from
the log instead (`attemptNumber` in `convex/pipeline.ts`): one per `started`
row for that session, step and — for transcription — answer, read through the
`jobLog.by_attempt` index so sibling answers do not conflict. Relaunches keep
counting, so an attempt above the pool's `maxAttempts` means an operator
relaunched it. Do not add an `attempt` argument to the job: it is fixed at
enqueue time and would read 1 on every retry, which is the bug this replaced.

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

### Rebinding: `fetch` can't be told which address to connect to

Checking a hostname with `dns.lookup` and then calling `fetch(hostname)`
resolves the name twice, so whoever controls the record can answer the check
with a public address and the connection with `127.0.0.1` (audit 2026-09-22,
`VALIDATION-RESULTS.md` lead 7). `fetch` has no public way to choose the
address; the only other route is an undici `Agent({ connect: { lookup } })` as
`dispatcher`, i.e. a second undici kept in step with the one inside Node. So
`convex/jobImportFetch.ts` uses `http(s).get` with a `lookup` that answers only
the checked addresses, and `agent: false` so no pooled socket is reused. The
hostname stays the host, so `Host`, SNI and certificate validation are
unchanged. Two traps:

- A pinned `lookup` must answer asynchronously (`setImmediate`). Answered
  synchronously, an immediate connection failure throws before `http` has
  attached its socket error handler.
- Resolver answers go through `isPrivateAddress`, not `isPrivateHost`: an
  answer that is not a well-formed address must fail closed, which a hostname
  predicate cannot do.

Responses are requested with `Accept-Encoding: identity` and not decompressed,
so the 2 MiB cap counts what is read; a server that compresses anyway yields
unreadable text and the import fails as too thin.

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
`.claude/settings.json`. It belongs in the hook
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

## Signed playback URLs: sign on what there is to play, never on the query

A Convex query result changes identity on **every** write to the rows it read.
An effect that re-signs playback URLs whenever `forSession` changes therefore
re-signs on a note, a decision, a `jobLog` row — and a SigV4 URL differs on
every signature (`X-Amz-Date`), so the `<video>` gets a new `src` and restarts
at 0:00. The opposite mistake (sign once) leaves every citation dead after the
URLs' hour. Both lived in the same effect (audit 2026-09-15, recruiter E3).

The pattern is `src/hooks/useSessionMedia.ts`: signing depends on a key naming
only what there is to play (`sessionMediaKey`: segment ids with an upload,
documents, `mediaPurgedAt`), re-signs on a 50-minute timer and on the player's
`error` event — except within 30 s of a fresh signature, which is a file that
cannot play, not an expiry, and shows an error instead of looping.

Trap: swapping a `<video>`'s `src` resets it to 0:00, paused, even for the
same file. `AnswerPlayer` sets `src` imperatively and restores `currentTime`
(and playback) on `loadedmetadata`; don't move `src` back into JSX.

## Decisions and report links are team-level

`reports.setDecision` and `shares.create` require `requireProjectAccess` — the
role's team plus org owners and admins — and no rank above that (audit Back
F2). This is deliberate: the team is the set of people hiring for the role, so
it is who reads the reports, who decides and who may show a report to someone
outside. Accountability comes from naming who acted, not from a rank:
`recruiterDecisionBy` and `decisionEvents` record every decision, and a share
link records its creator and is revoked when they leave the org (h03). Actions
that destroy or close things for candidates (archive, delete a role, cancel a
link, erase a candidate, relaunch an analysis) sit one tier higher,
`requireProjectOwnerOrAdmin`. Do not "harden" decisions to owner/admin without
a product decision: it would stop the people doing the hiring from recording it.

## The server reads a few UI strings from `src/locales`

`convex/lib/publishReadiness.ts` must recognise the example question and
criterion the wizard seeds, and `convex/reports.ts` names downloaded documents
in the recruiter's language. Both import the locale JSON directly
(`convex/tsconfig.json` has `resolveJsonModule` for it; esbuild bundles JSON
from outside `convex/` like any other import). A second copy of the strings in
`convex/` would drift the day the copy changes, and the publish gate would
silently stop recognising the example. Changing that copy is therefore a
behaviour change: a role seeded with the old text is no longer caught.

## Every thrown error code needs `errors:codes.<code>`

`errorMessageKey` resolves a Convex error code against the domain namespace
first, then the shared `errors:codes`. `src/lib/convex-errors.test.ts` reads
every `ConvexError(` in `convex/` and fails on a code with no en or fr message.
A computed code (`new ConvexError(someVariable)`) fails the test until it is
registered in the test's `DYNAMIC` map with the codes it can carry — derive
them from the code itself (as for `gate.state` and `publishBlockers`), never
list them by hand.

## An answer's byte cap and PUT lifetime come from its question

`reserveSegment` used to accept 300 MB per answer and sign its PUT for 15
minutes, whatever the question. Both now follow `question.maxResponseSeconds`
(`convex/interview.ts`):

- **Bytes**: `(maxResponseSeconds + 5) × rate + 1 MB`, with 512 KB/s for video
  and 32 KB/s for audio — **four times** what the recorder asks for
  (`src/lib/media/recorder.ts`: 1 Mbit/s, 64 kbit/s). The headroom is
  deliberate: `videoBitsPerSecond` is a request, a browser may overshoot it,
  and a candidate gets one attempt. If you raise the recorder's bitrates,
  raise these with them, or long answers start failing `media_too_large`
  before they upload.
- **PUT lifetime**: `maxResponseSeconds + 3 min`. S3 checks expiry when the
  request *starts*, so the window has to cover the audio upload, the video
  PUT that follows it and the client's retries (1 s, 2 s backoff) — not the
  transfer itself. Shortening it further breaks the video retry on a slow
  uplink; lengthening it re-opens the "bytes land after `finish` or erasure"
  window h01/h02 described.

## `expired` is written by a cron, a day after the role's deadline

`sessions.expireOverdueSessions` runs hourly and moves `pending` and
`in_progress` sessions to `expired` once their role's `expiresAt` is more than
**24 hours** old (B6). Three things follow from that:

- **The grace day is load-bearing.** `interview.finish` lets a candidate who
  recorded their answers finish after the role's deadline. Expire at the
  deadline itself and that path dies: the session is `expired`, not
  `in_progress`, and `finish` refuses it. Do not shorten the grace below the
  time a candidate might reasonably need to come back and press Finish.
- **Only the role's deadline is a window.** A role without `expiresAt` never
  expires its sessions; retention (`purgeAfter`, set at invitation) bounds
  what an unopened invitation keeps.
- **`expired` is terminal.** Pushing the deadline back after the cron ran does
  not reopen those links — the recruiter re-invites. Before it ran, it does.
- **The grace is for finishing, not for sending.** `invite` and
  `resendInvitation` refuse `project_expired` from the deadline itself: a link
  mailed during the grace day would open on "This interview has closed".

The pass is bounded (25 roles, 200 session writes) and reschedules itself
with the same cursor until the range is drained. It rescans every
past-deadline role each hour: two indexed reads per role, empty once drained.

## A dashboard figure is a bounded scan, and says when it saturated

There is no count operator. `dashboard.overview` reads, per figure, the index
that answers it (`by_org_and_invited` for the 30-day window,
`by_org_and_status` for completed interviews and roles), at most 400 rows
each, and returns `capped` for any scan that hit the bound; the page renders
it `400+`. It used to take the org's last 400 sessions of any status and
compute everything from them, so "decisions so far" dropped as pending
invitations piled up (Back M3). Same rule on `/app/admin` (`1000+`). If you
need exact totals, denormalise a counter in the mutation that changes the
status — do not raise the cap on a reactive query.

## Reduced motion collapses durations, and spares the spinner

`src/styles/app.css` answers `prefers-reduced-motion: reduce` once for the
whole app instead of per component. Durations go to `0.01ms`, not
`animation: none`: Radix waits for `animationend` before it unmounts a closing
dialog or menu, and an animation that never runs never fires it. `.animate-spin`
is put back afterwards, because a spinner that stops looks like a frozen page —
its rotation is the only sign work is still in progress. A new loop that
carries meaning the same way needs the same exemption.

## `ui/command.tsx` is not vendored: the search uses cmdk directly

The candidate search (⌘K) is the shadcn `CommandDialog` pattern built by hand:
`cmdk` inside the vendored `ui/dialog`. The shadcn registry
(`ui.shadcn.com`) was unreachable from the environment that wrote it, and
`src/components/ui/*` is never hand-written. When the CLI works, `pnpm dlx
shadcn@latest add command` and swapping `Command.*` for the vendored parts is
a mechanical change. `shouldFilter={false}` must stay: results are ranked by
the server, and cmdk would otherwise re-filter them on the client. `cmdk` is on
the candidate-bundle ban list in `eslint.config.mjs`.

## A `?raw` glob of a stylesheet is empty under Vitest

`import.meta.glob('./*.css', { query: '?raw' })` returns `''` for every file in
a Vitest run — the CSS pipeline claims `.css` before the raw loader does. A
test that asserts on stylesheet source reads it with `readFileSync` instead
(`src/styles/design-pass.test.ts`). `.ts`/`.tsx` sources glob fine.

## Sentry collects errors only

Decided in audit T15: `src/lib/sentry.ts` registers no tracing, no replay and
uploads no source maps. `tracesSampleRate` was removed because nothing read it
— `browserTracingIntegration()` is not among `@sentry/react`'s defaults, so the
option only suggested a performance view that never existed.
`beforeSendTransaction` stays although it is inert today: whoever turns
tracing on must not be the one who ships `/s/<token>` in transaction names.

What that costs: a crash report, `InterviewCrash` included, arrives with a
minified stack. Turning that around is three changes that go together —
`build.sourcemap: 'hidden'` in `vite.config.ts`, `@sentry/vite-plugin` with a
`SENTRY_AUTH_TOKEN` in the Vercel build, and deleting the maps from
`.output/public` after upload so they are never served. Replay is a separate
decision, and not a configuration one: on `/s/**` it would film a candidate's
interview screen for a third party.

## `pnpm audit` in CI: an override, or a lockfile refresh

CI runs `pnpm audit --prod --audit-level=high`. `--prod` is less of a filter
than it sounds: `@tanstack/react-start` is a runtime dependency, so its whole
build chain (vite, postcss, babel, browserslist) counts. When the step goes
red, in order:

1. **The patched version is already inside the parent's range** — refresh
   the lockfile for that package only:
   `pnpm update --depth Infinity --config.minimum-release-age=4320 <pkg>`.
   `package.json` does not change. The flag is in minutes (three days), the
   same cooldown `renovate.json` puts on automerge: it keeps the refresh from
   pulling a version published this morning. Review the `pnpm-lock.yaml` diff
   — it should touch the named packages and their own dependencies only. This
   is how js-yaml, nanoid, postcss and browserslist were cleared.
2. **The parent pins a vulnerable range** — add a `pnpm.overrides` entry in
   `package.json` (never in `pnpm-workspace.yaml`, see § "pnpm 11 silently drops
   `pnpm.overrides` and `onlyBuiltDependencies`"). Use a caret on the patched version (`^8.21.0`), not
   `>=`: `>=` lets a future install jump the parent onto a new major it was
   never built against. `ws` (via `convex`) and `dompurify` (via
   `streamdown` → `mermaid`) are overridden this way; both reach users.

Moderate and low advisories do not fail the step; Renovate clears most of
them with their parents.

The step can go red with no change in the PR: an advisory published overnight
turns every branch red at once, which is the point of the gate. Never mute it
or add `--ignore` to get a PR through — a finding that genuinely does not apply
is argued in the PR body, and its advisory id recorded here.

## The candidate bundle budget reads the start manifest

`pnpm bundle:budget` (after `pnpm build:app`; in CI after `pnpm build`) fails
above 280 KiB gzip for what `/s/$token/interview` loads: the preloads TanStack
Start lists for `__root__`, `/s/$token` and `/s/$token/interview` in
`.output/server/_tanstack-start-manifest*.mjs`, plus their static imports.
Lazy `import()` chunks are not counted.

- **Raised from 270 to 280 KiB on 2026-09-25**, when the audit stack met #38
  (crash-safe takes in IndexedDB, wake lock, live mic check): 275.8 KiB, all
  of it candidate-facing features. The reduction is its own task — load i18n
  namespaces per route (`i18n` chunk ~50 KiB) and keep the Better Auth client
  out of the entry chunk candidates load.
- **It was 265.2 KiB when the budget was first set** — 4.8 KiB of headroom. The
  shared entry chunk alone is ~148 KiB (Convex client, Better Auth client,
  sonner). A change that crosses the line has to pay for itself, or move
  something recruiter-only out of `~/lib/*`; raising the number is the last
  resort and needs a reason in the PR.
- **KiB, 1024 bytes.** Vite prints kB of 1000 bytes: the same build reads
  271.6 kB there.
- **A TanStack Start bump can rename or reshape the manifest.** The script
  then fails loudly ("no start manifest", "route … is missing") rather than
  measuring nothing — read the new manifest, don't delete the step.
