# TESTING — end-to-end validation plan

Manual + automated plan to validate a fresh copy of the template before
forking it into a production SaaS. Allow ~70 min end-to-end.

Prerequisites:

- `pnpm install`
- `pnpm exec convex dev` run once (provisions the deployment)
- Convex environment variables set:
  - `BETTER_AUTH_SECRET`
  - `SITE_URL` (`http://localhost:3000` locally)
  - `RESEND_API_KEY` + `RESEND_FROM` + `RESEND_TEST_MODE=true` in dev
  - `MISTRAL_API_KEY` (transcription, evaluation and the AI chat agent)
- `.env.local` filled in (`VITE_CONVEX_URL`, `CONVEX_DEPLOYMENT`)
- 2 browsers (or 1 browser + 1 incognito window) ready for multi-tenant tests

## Level 0 — Before the first run (one-off, ~20 min)

Nothing below Level 1 works without these, and the first one cannot be
undone later.

| #  | Step | How | Why it matters |
| -- | ---- | --- | -------------- |
| P1 | **Create the Convex project in EU West (Ireland)** | Choose the region in the Convex dashboard when the project is created, and set the team default so preview deployments follow | The region is fixed at creation. Changing it later means a new deployment and an export/import migration. Candidate video is the most sensitive data this product holds |
| P2 | Private S3-compatible bucket | Scaleway Object Storage, region `fr-par`, bucket **not** public. Set `OBJECT_STORE_*` on the Convex deployment (see `.env.example`) | Every object is served through a signed URL minted after an access check. A public bucket silently defeats all of it |
| P2a | **CORS on the bucket** | `PutBucketCors` with `AllowedOrigins` = the exact web origins (dev bucket: `http://localhost:3000` and the staging host; prod bucket: the prod host only), `AllowedMethods` PUT + GET, `AllowedHeaders` `Content-Type` + `Content-Length`, `MaxAgeSeconds` 3600 — then read it back from the bucket | The browser PUTs the recording straight to the bucket with a signed URL, so every upload starts with a CORS preflight. No rule, no preflight, no upload — and the failure surfaces as a generic network error in the candidate's browser, days before anyone looks. One rule per bucket: dev and prod are separate buckets and neither inherits the other's |
| P3 | Verify the bucket is private | `curl -I https://<bucket>.<endpoint>/probe.txt` on an object you uploaded | Must be `403`. A `200` means every candidate recording is world-readable |
| P4 | Model provider key | `MISTRAL_API_KEY` on the Convex deployment — one key for transcription, evaluation and the AI chat agent | The pipeline fails at the first step without it, visibly, in `jobLog`, and the chat agent's reply fails visibly in the AI panel. There is deliberately no second provider key: see `.env.example` § "AI provider" |
| P4b | **Retire the chat agent's old key** | On every deployment that ever ran `pnpm setup`: `pnpm exec convex env remove ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` (add `--prod` for production) | The code stopped reading them, which is not the same as them being gone: a credential nothing calls is a credential nobody rotates or notices, and it stays valid and billable until someone removes it |
| P4a | **The model actually answers, on both paths** | Push a throwaway `internalAction` calling `complete()` to the dev deployment and run it with `npx convex run`, **then** run level 5 C3 (ask the assistant a question that needs a tool) | Every stub in the unit suite is hand-written, so none of them can discover that a provider disagrees with its documented response shape — which is exactly how a block-shaped `content` reached production. The id in `convex/lib/ai.ts` now drives two clients: the hand-rolled one in `complete()` and `@ai-sdk/mistral` in `convex/agent.ts`, which also needs tool calling and streaming. Do both halves whenever that id changes. See `KNOWN_ISSUES.md` § "A reasoning model does not answer in a string" |
| P4b | **`PURGE_HASH_SALT` on the Convex deployment** | `pnpm exec convex env set PURGE_HASH_SALT "$(openssl rand -hex 32)"`, distinct per deployment | The erasure register stores a hash of the candidate's address, not the address. Unsalted, that hash is reversible by dictionary — the register would hold the data it exists to prove it destroyed. Unset, every erasure path throws `purge_hash_salt_not_configured`, on purpose |
| P5 | Resend delivery webhook | Point a Resend webhook at `https://<convex-site-url>/resend-webhook`, store `RESEND_WEBHOOK_SECRET` | Without it a bounced invitation is indistinguishable from a candidate who has not opened it |
| P6a | `MEDIA_ORIGIN` on the **web server** (each Vercel project's env, or `.env.local` for `pnpm dev`) | The bucket origin signed URLs point at, e.g. `https://interw-media.s3.fr-par.scw.cloud` | The CSP is served by the web server, which never talks to the bucket, so this is the one object-store setting that does not live on the Convex deployment. Unset, `media-src` falls back to `https:` — video still plays, but from any host |
| P6 | Sentry for the backend | Convex dashboard → Settings → Integrations → Sentry | Convex reports thrown exceptions from actions through its own log stream; there is deliberately no Sentry SDK in the Convex runtime. The code's part of the contract is to never swallow an error, which `pnpm lint` and code review enforce |

## Level 1 — Build & smoke (automated, 2 min)

| #  | Step          | Command                  | Expected result               |
| -- | ------------- | ------------------------ | ----------------------------- |
| B0 | Toolchain pin | `pnpm --version`         | Matches `packageManager` in `package.json` exactly. Run this **first**: on a mismatch B1–B3 fail with `ERR_PNPM_IGNORED_BUILDS`, which blames esbuild rather than the pnpm version |
| B1 | Typecheck     | `pnpm typecheck`         | Exit 0, no errors             |
| B2 | Lint          | `pnpm lint`              | Exit 0, 0 warnings            |
| B3 | Build         | `pnpm build`             | Bundle written to `.output/`  |
| B4 | Smoke E2E     | `pnpm test:smoke`        | All scenarios pass. Covers the headers the product depends on (`camera=(self)`, `microphone=(self)`, a `media-src` carrying `blob:`) and the two token surfaces: `/s/<invalid>` and `/r/<invalid>` answer identically for an unknown and a malformed token, and both carry `noindex, nofollow` |
| B5 | Prod cookies  | `pnpm test:cookies`      | `interw.session_token` has Secure+HttpOnly+SameSite=Lax+Max-Age≈604800 |
| B6 | Skills intact | `pnpm sync:skills:verify` | `Vendored skills match skills-lock.json.` (exit 0) — offline, covers the `SKILL.md` files **and** their `references`, plus `.claude/skills/` symlinks with no lock entry (`~ <name>: .claude/skills link with no lock entry`, exit 2 — repair with `pnpm sync:skills`) |
| B6b | Skills up-to-date | `pnpm sync:skills:check` | `Skills up to date with upstream.` (exit 0) — network. Two distinct failures, both exit 2: `~ N skills drifted` (upstream changed) and `✗ … N skills could not be checked` (404 or network — the skill is tracked by nothing) |
| B7 | Unit + integration tests | `pnpm test` | All suites pass. Covers SigV4 against AWS's own vectors, weight normalisation, the session gate, the candidate projections, evidence anchoring, the report builder, para-verbal metrics, locale parity, cross-organisation isolation under `convex-test`, and that the chat agent still resolves to the pipeline's provider and model |
| B8 | Convex codegen committed | `pnpm codegen:api:check` | `convex/_generated/api.d.ts is up to date.` Fails when a Convex module was added without committing its codegen — CI has no deployment, so `npx convex dev` cannot do it there |
| B9 | Access audit | `pnpm audit:access:check` | Exit 0. Fails on any **public** Convex function with no access check. Run `pnpm audit:access` to print the full matrix; deliberate exceptions are declared with a `// access: <reason>` comment above the export and are listed in the output |
| B10 | Candidate interview, real browsers | `DEPLOY_CONVEX=true pnpm build && pnpm test:e2e` | Chromium and WebKit, fake camera and microphone: consent, device check, two answers recorded, the bucket cut during the second upload and the failure shown, "Try again" saves it, a reload lands back on the saved review, finish; then `completed` with two `uploaded` segments read back from the database, and the test candidate erased. Needs `CONVEX_DEPLOY_KEY`, `VITE_CONVEX_SITE_URL` and `MEDIA_ORIGIN` for a deployment whose bucket CORS allows `http://localhost:3000` — the build deploys this branch's functions to it. The HTML report (`playwright-report/`) carries captures of the recording screen |

B2–B3, B6, B6b, B7, B8 and B9 also run in CI on every PR (`.github/workflows/ci.yml`,
B6 via the `skills-verify` job, B6b via `skills-drift`). B10 runs in the `e2e`
job, on repository secrets — after each merge to `main` and on demand, not on
PRs (why: comment above the job). CI covers B0
implicitly: `pnpm/action-setup@v4` is given no `version:`, so it installs the
`packageManager` version and cannot drift from local.
B4–B5 remain local: they require a provisioned Convex deployment.

## Level 2 — Auth (6 min)

UI minutiae (exact text, spinners, skeletons, aria-label) are not listed
here — they fall under visual CI + typecheck. This level covers only
behaviours that can **silently regress**.

Test with a fresh user "Alice" (`alice@test.local`).

| #   | Step                                                   | Expected result                                                                   |
| --- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| A0  | `/` in EN then FR                                      | Value proposition (questions on camera → candidate answers when they want → every claim linked to its second of video) + primary "Create account" CTA. No "MVP starter" anywhere, including the browser tab title. |
| A1  | `/register` → submit, onboarding org "Acme"            | Redirects to `/app/acme`, user created, `superAdmin: true` (first user). If `DEV_NOTIFY_EMAIL` is set, a "[interw] New signup: …" email arrives in that inbox (1× per new user, not on re-login). |
| A2  | Sign out → re-sign in correct                          | Redirects to `/app/acme` (last org via `lastOrgSlug`)                              |
| A3  | Sign in with wrong password                            | Inline destructive `<Alert>` above the form (not a toast). No session.            |
| A4  | `/app/acme` unauthenticated                            | Redirects to `/login` (bare — the app never generates `?redirect=`, so the return URL is **not** preserved; see `KNOWN_ISSUES.md` § "A return-URL search param needs the URL parser") |
| A5  | `/app/me` → change password                            | Success toast **+ "Password changed" email** (anti-takeover) + other sessions invalidated |
| A5b | Change password 3× within a minute                     | Two "Password changed" emails, then none; each change still succeeds (`passwordChangedNotify` bucket, per user) |
| A6  | Magic link for registered + unregistered email         | Identical privacy-respecting toast. No `users` row created for unknown email.     |
| A7  | Forgot → reset chain (email → token → new password)    | Sign-in with new password works. All pre-reset sessions invalidated.              |
| A8  | `/reset-password?token=expired` (or no token)          | Card "Invalid or expired link" + primary CTA "Send a new reset link"              |
| A9  | `/register` with already-registered email              | **Same** "Check your inbox" screen as a new signup (anti-enumeration), no email sent |
| A10 | Rate-limit (sign-in 6×, sign-up 4×, magic 4× /60s)    | "Too many attempts…" toast via classifier (no raw BA message)                     |
| A11 | `/app/me` → change email                               | **Approval email** arrives at the **current** address (anti-takeover), not the new one |
| A12 | **Verification needs the password** | `/register`, click the email link | Lands on `/login` with a "Last step: enter the password you chose…" notice, **not** signed in yet. Enter the password → signed in and redirected. Hijack variant: browser A registers B's address with password P; in B's mailbox click the link and enter any other password → "invalid email or password", still unverified; A signing in with P → "email not verified" |
| A12b | Verification link opened while signed in to **another** account | Sign in as A, then open B's verification link | "You're signed in as A…" card, **not** a bounce to `/app`. "Sign out and continue" → login form with the notice; B's password verifies B. "Stay signed in" → `/app` |
| A12c | Expired verification link | Open a sign-up link more than 1 h old (or tamper with `token=`) | `/login` with "This verification link has expired…" notice. Correct password → "not verified" banner + Resend; the new link works |
| A12d | Google on an unverified password account | `/register` with a Gmail address, don't verify, then "Continue with Google" with that address | Back on `/login` with "An account already exists for this email, but it isn't verified yet…" toast (not the generic provider error) |
| A13 | Email change, cross-device | `/app/me` → change email, approve from the old inbox, then click the new-address link in a fresh browser | Sent to `/login`; after signing in with the old address and password the change completes. Without signing in, nothing changes |
| A12 | Password constraints (`/register` + `/reset-password`) | <12 chars → Zod block. HIBP leak → "appeared in known data breaches". zxcvbn meter visible. |
| A13 | Password match feedback `/reset-password` + `/register` | Match → green ✓ "Passwords match". Mismatch → red case-sensitive hint.           |
| A14 | Resend (verification & reset)                          | 2nd email arrives if address exists. Neutral privacy-respecting toast.            |
| A15 | Network error (offline) on magic-link + forgot         | Inline `<Alert>` "Network error" (no misleading false "link sent").               |
| A16 | `/app/me` Sessions → list + Revoke + "Sign out others" | Current session = "Current" badge, no Revoke button. Revoking others works. "Sign out other devices" asks confirmation then invalidates all except current. |
| A17 | **Cross-tab persistence** (localhost regression)       | Sign in on tab A → open tab B on `/app/acme` → stays logged in. Hard-refresh each tab 3× → still logged in. |
| A18 | Onboarding org with reserved slug (`admin`, `api`, `me`) | Inline "This slug is reserved" feedback below the input. Submit toast "slug_reserved". |
| A19 | Onboarding org with already-taken slug                 | Inline "This slug is already taken" feedback in real time (before submit). Submit toast "slug_taken". |
| A20 | **Google sign-in** — without `GOOGLE_CLIENT_ID/SECRET` | `/login` + `/register`: **no** "Continue with Google" button or separator (clean template, no errors). |
| A21 | **Google sign-in** — with credentials + redirect URI in Google Console (`${SITE_URL}/api/auth/callback/google`) | Button visible. New user → redirects to `/app`, `users` row created. Email matching an existing password account → **no** duplicate `users` row (email dedup). |
| A22 | Google OAuth failure (cancelled / error)               | Returns to `/login?error=…` → toast "Couldn't sign in with that provider".        |
| A22b | **Google in prod** — after `pnpm run setup:prod` (Google creds present in dev) | `convex env list --prod` contains `GOOGLE_CLIENT_ID`; prod redirect URI added to the same Google client; button visible on prod domain, sign-in works. |
| A24 | **Open redirect** — sign in from `/login?redirect=https://evil.com`, then from `/login?redirect=/%09/evil.com` (tab-smuggling) | Both land on `/app`, **never** off-site. The hostile param is dropped silently — normal login page, no error screen. Repeat with `//evil.com` and `/\evil.com`. |
| A25 | **Return URL preserved** — sign in from `/login?redirect=/app/acme/projects` | Lands on `/app/acme/projects` (internal paths still work — the guard rejects origins, not paths). |

> **A23+ (known gaps)**: no "Password changed" email on the
> `/forgot-password → /reset-password` flow, nor NewDeviceEmail — see
> `KNOWN_ISSUES.md` § "Post-event notification coverage" for the roadmap.

## Level 2 — Internationalisation i18n (8 min)

App is bilingual FR/EN. English by default, French when the browser/preferences
request it. Architecture details: `KNOWN_ISSUES.md` § "i18n (react-i18next) SSR".

| #   | Step                                                                  | Expected result                                                                                   |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| I1  | Browser in `en-US`, `lang` cookie cleared, visit `/`                 | Everything in English. `<html lang="en">`. No flash.                                              |
| I2  | Force `Accept-Language: fr-CA` (DevTools or `curl -H`), cookie cleared, reload `/` | **From the SSR HTML source** (View Source, JS disabled) everything is in French. `<html lang="fr">`. |
| I3  | Reload in FR several times                                            | Console **without** "Text content does not match" warning (no hydration mismatch).                |
| I4  | Language switcher (footer sidebar, connected, or corner of `/`)       | Instant FR↔EN toggle. `lang` cookie updated. Survives reload.                                     |
| I5  | Logged in, change language                                            | `users.preferredLanguage` patched (check Convex dashboard).                                       |
| I6  | Variants `fr-BE` / `fr-FR` / `fr`                                    | All → French (any fr variant).                                                                    |
| I7  | Emails (reset password, invitation) for a user with `preferredLanguage=fr` | Subject + body in French; for EN/no-pref user → English.                                    |
| I8  | Wrong credentials in FR / invalid form in FR                         | FR auth error message (via classifier); FR Zod messages.                                          |
| I9  | Regression grep: `git grep -nE "\"[A-Z][a-z]+ " src/routes src/components` | No hardcoded UI string outside `src/components/ui/*` (shadcn chrome).                       |

## Level 2 — App shell UI (10 min)

Logged in as Alice on `/app/acme/`.

| #    | Step                                                          | Expected result                                                   |
| ---- | ------------------------------------------------------------- | ----------------------------------------------------------------- |
| SH1  | `inset` sidebar (floating rounded card): Platform group at top; Members / Invitations / Settings pinned at bottom (`mt-auto`, no label) | OK; admin-only items hidden for "member" role |
| SH2  | Click `SidebarTrigger` (header) OR the `SidebarRail` (thin strip on the right edge of the sidebar) | Sidebar collapses to `icon`; `sidebar_state` cookie persists; org/profile icons not overwritten in `icon` mode |
| SH3  | Resize < 768px                                                | Sidebar switches to `Sheet` mobile, opened via burger             |
| SH4  | Navigate Dashboard → Roles → Settings → Members               | Header breadcrumb updates on each route                           |
| SH5  | Dashboard: KPI cards + recent candidates                      | Counts consistent with `dashboard.overview` / `listMembers`       |
| SH6  | Dark mode toggle (sun/moon icon in header)                    | Page switches light ↔ dark, sidebar + charts adapt               |
| SH7  | Theme picker (sidebar footer) → choose Blue / Emerald / Violet | Primary + chart-1 change; survives reload (localStorage)          |
| SH8  | Org switcher (sidebar header), org **without** a logo         | Initial (first letter) centered in the rounded square; lists orgs; click switches route + persists `lastOrgSlug` |
| SH9  | NavUser (sidebar footer) → profile / switch org / sign out    | **Round** avatar; without photo, first+last initials (e.g. `BB`); same destinations as before the refactor |
| SH10 | AI button in header (or ⌘J / Ctrl+J)                          | Toggles the AI panel (desktop rounded box / mobile overlay); state persists via the `ai_panel_state` cookie |
| SH11 | Open a page taller than the viewport (e.g. a long roles list) | The `inset` frame stays fixed to viewport height; scroll happens **inside** the frame, rounded bottom edge always visible |
| SH12 | Unknown URL (e.g. `/app/acme/nope` or `/nope`)                | Styled 404 card (FR/EN by locale) + back-home button              |
| SH13 | Dashboard / Roles on initial load                             | Animated skeletons (KPI, recent candidates, table) — no naked "Loading…" text |
| SH14 | "What's new" button (sidebar footer, badge visible on first visit) | Dialog previews the most recent dated FR/EN entries (up to 3); badge disappears after opening and does not return on reload. Every entry shows **prose**, never a raw `entries.<id>.title` key |
| SH15 | "What's new" dialog → "See all updates" (`/app/$orgSlug/changelog`) | Dedicated page lists the full history newest-first, FR/EN by locale; browser tab title reflects the locale. The history is Interw's own — no entry from the template it was forked from |

## Level 2 — Data table (5 min)

On `/app/acme/projects` (roles) — the shared `src/components/data-table/`
primitives, whose copy lives under `common:dataTable.*`.

| #   | Step                                                 | Expected result                                                   |
| --- | ---------------------------------------------------- | ----------------------------------------------------------------- |
| T1  | Sort by a column (click header → dropdown)           | Asc/Desc works in both locales, indicator visible                 |
| T2  | Pagination (create >10 roles)                        | next/prev/first/last buttons + page size 10/20/30/50              |
| T3  | Page size + "X of N row(s) selected" counter         | Translated, no raw `common:dataTable.…` key on screen             |

## Level 2 — Multi-tenant (15 min)

Still logged in as Alice. Prepare a second browser for Bob.

| #   | Step                                                        | Expected result                                                     |
| --- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| M1  | `/app/acme/settings/invitations` → invite `bob@test.local`  | Email sent, listed as pending                                       |
| M2  | Browser 2 (incognito) → open the invitation link            | `/accept-invite/<token>` accessible unauthenticated                 |
| M3  | Sign up Bob via the invitation flow                         | Bob created, automatically a member of Acme with "member" role. **No email-verification step**: the invite token pre-verifies the email (token-gated), Bob is signed in and lands on `/app/acme` directly |
| M4  | Bob visits `/app/acme/projects`                             | Sees the roles he is allowed to see, can create one                 |
| M5  | Alice changes Bob's role → "admin"                          | Persists, Bob sees the updated badge                                |
| M6  | Bob creates a second org "Beta"                             | Switches to `/app/beta`, Alice is NOT a member                      |
| M7  | Alice navigates to `/app/beta` directly                     | Redirects to `/app` or 403                                          |
| M8  | Roles isolated: Alice sees Acme roles only                  | No Beta role on Alice's side                                        |
| M9  | Switch org via top-bar dropdown                             | Routes recalculated, roles reloaded                                 |
| M10 | Bob (Acme admin) deletes a role created by Alice, no candidate invited yet | Allowed (owner/admin)                                 |
| M11 | Non-admin member tries to delete another user's role        | Error "insufficient_role", no deletion                              |

## Level 3 — Invitations edge cases (8 min)

| #  | Step                                                       | Expected result                                                     |
| -- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| I1 | Invite an email already a member                           | Error "already_member", no duplicate                                |
| I2 | Invite the same email twice (both pending)                 | Rejected or replaces the invitation, no duplicate                   |
| I3 | Accept an expired invitation (force `expiresAt` in past), not yet a member | Error "expired", no member added                          |
| I4 | Re-open an invite link already accepted (still a member)   | **No error**: idempotent no-op, re-lands on `/app/<org>` (the accept effect can fire twice / second tab — replayable) |
| I5 | Accept invitation with a different account than the one invited | `/accept-invite` shows the "wrong account" switch card; a forced backend `accept` for a non-member with a mismatched email throws "email_mismatch" |
| I6 | Spam 25 invitations in < 1h                                | Rate-limit triggers → "rate_limited" after threshold                |
| I7 | Revoke a pending invitation                                | Disappears from list, link becomes invalid                          |
| I8 | Verify `RESEND_TEST_MODE=true` sends no real email         | Convex logs show "skipped (test mode)"                              |
| I9 | **Token-gated security** — sign up at `/register` with NO valid invite token (normal signup) | Email is **not** pre-verified: verification email sent, `emailVerified` stays false until the link is clicked. A signup whose `inviteToken` is absent/stale/for another email never bypasses verification |
| I10 | Email-match casing — invite `Bob@Test.local`, accept signed in as `bob@test.local` | Accepted (match is case- and whitespace-insensitive on both sides) |
| I11 | Sign up from `/register?redirect=/accept-invite/<token>` (not the inline accept page) | Lands **in the org** (`/app/<org>`), not stuck on `/app`: token-gated signup → signin → full nav to the accept page, which attaches the member. Parity with the inline `/accept-invite` flow |

## Level 4 — Uploads (5 min)

| #  | Step                                                    | Expected result                                                   |
| -- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| U1 | `/app/me` → drag/drop avatar (PNG < 5 MB)               | Upload OK, avatar visible in top bar                              |
| U2 | Avatar > 20 MB                                          | Rejected (Convex cap)                                             |
| U3 | `/app/acme/settings/general` → upload org logo          | Logo visible in top bar and member list                           |
| U4 | Replace an existing logo                                | Old one replaced, no orphan (check `_storage`)                    |
| U5 | As a plain member, call `files:setMyAvatar` with the org's logo id, or a colleague's avatar id | Refused `not_found`; the logo and the colleague's avatar are untouched. `organizations:bySlug` returns no `logoStorageId` |

## Level 4 — Account lifecycle (8 min)

| #  | Step                                                    | Expected result                                                   |
| -- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| L1 | `/app/me` → change email                                | Verification email sent to the old address                        |
| L2 | Click the verification link                             | Email updated, sessions still valid                               |
| L3 | `/app/me` → delete account                              | Confirmation email sent                                           |
| L4 | Click the link in the delete email                      | Convex user purged, memberships removed, BA user deleted          |
| L5 | Deleted user attempts `/login`                          | Auth fails                                                        |

## Level 4 — Super-admin (5 min)

| #   | Step                                               | Expected result                                                   |
| --- | -------------------------------------------------- | ----------------------------------------------------------------- |
| SA1 | `/app/admin` accessible only for `superAdmin: true` | Bob (non-SA) → 403/redirect                                      |
| SA2 | List all users across all tenants                  | Exhaustive list, pagination works                                 |
| SA3 | Toggle `superAdmin` on another user                | Persists, the other user sees `/app/admin`                        |
| SA4 | Last-SA guard: remove own SA flag when sole SA     | Error "cannot_demote_last_superadmin"                             |
| SA5 | `purgeExcept` (dev cleanup) — dev only             | Keeps only the specified email, deletes everything else           |
| SA6 | **Pipeline health** | Counts per step and outcome over 24 h and 7 days. A figure shown as `200+` saturated the scan cap, deliberately — there is no count operator, so a bounded scan is the honest answer |
| SA7 | **Finished without a report** | Lists interviews the candidate completed that produced no assessment, with how many answers settled. Empty is the normal state |
| SA8 | **Relaunch** | Puts one named session back through the pipeline and records a `relaunch` row in `jobLog` carrying the operator's user id in `actorId` — never their address. Running it twice changes nothing the first run did not. Refused for a session that is not `completed`, for one whose report job still holds its claim (`report_in_progress`), and for anyone who is not a super-admin |

## Level 5 — AI panel (10 min)

| #   | Step                                                    | Expected result                                                   |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| C1  | Open `/app/acme`                                        | AI panel open by default in its rounded box (desktop right column); latest thread resumed, else empty state with suggestions |
| C1b | Press ⌘J / Ctrl+J (or the header AI button), then reload | Panel toggles; state persists across reload (cookie `ai_panel_state`) |
| C2  | Send a simple message ("ping")                          | Stream visible token by token; "Thinking…" before first token; no UI blocking |
| C2b | Ask for a formatted response ("bullet list + bold")     | Markdown rendered via streamdown (bullets, bold, inline code, tables) |
| C2c | Ask it to reply with `![chart](https://example.com/x.png)`, then with `<img src="https://example.com/x.png" alt="chart">` | Both show "[Image not shown: chart]" ("[Image non affichée : chart]" in FR); DevTools › Network shows **no** request to example.com. Links still open the confirmation modal |
| C3  | Ask the agent "list my open roles" (an empty-state suggestion) | `listRoles` runs (read-only, no approval), collapsible tool call, response lists Acme roles |
| C4  | Ask it to reject a candidate, invite someone, or change a role | It refuses and points at where to do it in the app. **Every tool is read-only** — a hiring decision is never a tool call |
| C5  | While a long answer streams, click **Stop**             | Generation aborts                                                 |
| C6  | Spam 30 messages in 1 min                               | `chatSend` rate-limit triggers (also gates approvals). `POST https://<deployment>.convex.site/api/chat` → `404`: no chat entry point outside the metered mutations |
| C7  | New chat (+), rename and delete a conversation          | Title updates; thread + messages removed                          |
| C8  | From `/app/beta`, verify Acme threads are NOT listed    | Org isolation confirmed (scope `${orgId}:${userId}`)             |

## Level 6 — Security + deployment (5 min)

| #  | Step                                               | Expected result                                                   |
| -- | -------------------------------------------------- | ----------------------------------------------------------------- |
| S1 | No secret with `VITE_` prefix                      | `grep -r "VITE_.*SECRET\|VITE_.*KEY"` → empty                    |
| S2 | No top-level `process.env.X` in `src/`             | Check client-side bundle                                          |
| S3 | Security headers present (CSP, HSTS, etc.)         | `curl -I http://localhost:3000` → expected headers. Specifically `permissions-policy: camera=(self), microphone=(self)` — an empty `camera=()` denies the app's **own** camera — and a CSP `media-src` listing the bucket origin and `blob:` (B4 asserts both) |
| S4 | Better Auth CORS restricted to `BETTER_AUTH_URL`   | Request from another origin → blocked                             |
| S5 | Webhooks HMAC: modified payload → rejected         | Manual test with a tampered payload                               |
| S6 | `pnpm build` + `pnpm start` (local prod)           | The prod bundle runs without warnings                             |
| S7 | `VITE_CONVEX_URL=… VITE_CONVEX_SITE_URL=… pnpm build:app`, then `PORT=8080 pnpm start` | `200` on `/` and `/login`. Built without those vars, the first render fails with `CONVEX_SITE_URL is not set` — they are build-time, not runtime |
| S8 | Deployed app: `curl -I https://<domain>/`          | `200`, served by the Node server (not a static 404)                |
| S9 | Vercel build log (staging and prod)                | Shows `pnpm v10.x` from `packageManager`, then `convex deploy` targeting **that environment's** Convex project before the Vite build, then `[nitro:vercel]` |
| S9a | Open a PR, then look at both Vercel projects | Each shows the PR's deployment as **Canceled** by the ignored build step. A PR that *builds* has a path to a deploy key — see `KNOWN_ISSUES.md` § "Vercel previews must never carry a deploy key" |
| S10 | **Import a job ad refuses to reach inwards** | Paste, in turn: `http://169.254.169.254/latest/meta-data/`, `http://[::1]/`, `http://2130706433/`, `http://100.64.0.1/`, `http://printer.local/`, and a URL that 302s to any of them | All refused with `invalid_url`. The request is made by the deployment, not the browser, and its content comes back summarised by a model — so the channel is readable, not just reachable. `convex/lib/safeUrl.test.ts` holds the full table. The connection is also pinned to the addresses the check approved (DNS rebinding) — `convex/jobImportFetch.test.ts` covers it, and asserts the TLS server name is still the hostname |
| S11 | **Where the evaluation runs** | Read a `report` request body in the Convex logs | It carries `provider: { data_collection: 'deny', allow_fallbacks: false }`, and the prompt carries the transcript but **not** the candidate's name |

---

# Interw surfaces

The levels above validate the platform this product is built on — auth,
multi-tenancy, uploads, the app shell. The levels below validate Interw
itself. Run them after Level 6, before any production deployment.

Two of them are the ones that actually matter, and neither can be automated
here: **IB12** (cutting the network mid-answer) and the Safari pass of
**Interw B**. A candidate gets one attempt; everything else in this document
is cheaper to get wrong.


## Interw A — Roles (12 min)

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IA1 | Create a role | `/app/{org}/projects` → New role → title + language → Create | Lands in the wizard on step 1, status **Draft** |
| IA2 | Questions | Wizard → Questions → **Add a question** three times, edit the text, reorder with the arrows | Each click opens an editable card seeded with the example question. `questions.create` refuses empty text, so the button must never send it — a toast saying the question needs text is the bug this row exists for. Order persists on reload; indices stay contiguous |
| IA3 | Record a question | Questions → Record this question → speak → Stop | Uploads, then shows **Recorded**. Check the object exists in the bucket under `orgs/{orgId}/projects/{projectId}/q-{questionId}.*` |
| IA4 | Re-record | Record again with a different browser (WebM vs MP4) | The old object is deleted, not orphaned. Exactly one `q-{questionId}.*` remains |
| IA5 | Criteria and weights | Add three criteria with weights 10 / 10 / 10 | Each shows **34% / 33% / 33%** — never 33/33/33 |
| IA6 | Publish gate | Try to publish with no question | Refused with "Add at least one question" |
| IA7 | Import a job ad | Questions → Import from a job ad → paste a real published ad URL | Draft appears with the requested number of questions and criteria summing to 100. **Nothing is saved** until "Add all to the role" |
| IA7b | Import from a client-rendered board | Same, with an ad from Welcome to the Jungle, Indeed, or an ATS career page | Works. Those pages render the ad in the browser and leave nothing readable in the markup, so the draft comes from the `JobPosting` JSON-LD they publish for Google for Jobs — not from `page_too_thin` |
| IA7c | A board that refuses to be read | Paste an ad from a site behind a bot wall | Refused with "refuses automatic reading" (`page_blocked`), never "check the link" — the link is fine, the site said no |
| IA8 | Import SSRF guard | Paste `http://127.0.0.1:8080/`, `http://169.254.169.254/`, `http://2130706433/` and a URL that 302s to one of them | All refused as "not a public web address". See S10 and `convex/lib/safeUrl.test.ts` for the full table |
| IA9 | Restrict a role | Share → name one colleague → Save | A different member (non-admin) no longer sees the role in the list, in search, or by URL — and gets **not found**, not "forbidden" |
| IA10 | Archive | Archive an active role | Becomes read-only; editing is refused; restoring returns it to **Draft**, never straight to Active |
| IA11 | Archiving needs owner or admin | As a plain member of the org, try to archive a live role | Refused. Archiving closes the link of every candidate mid-interview at once, so it is no longer less protected than deleting an empty role |
| IA11b | Actions follow the tier | As a plain member, open ⋯ on a role someone else created, then that role's page | Only **Edit**: no Share, Archive or Restore. On a role you created, they are shown; admins and owners see them everywhere. The server refuses the member anyway (`insufficient_role`) — this row checks the UI does not offer what will fail |

### Editing a role that already has candidates

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IA12 | Deleting a question is refused | Invite one candidate, then try to delete a question | Refused (`project_has_sessions`). Deleting renumbers every following question, and the numbering a candidate is looking at mid-interview would change under them |
| IA13 | Reordering is refused | Same role, drag a question | Refused for the same reason. Editing a question's **text** is still allowed: that changes what was asked, not which answer belongs to it |
| IA14 | An answer stays under its own question | On a role whose questions were edited before this change shipped, open a report | Each answer sits under the question that was actually asked. The join is by `questionId`, not by position |

## Interw B — Candidate journey (20 min, repeat per browser)

Run the whole level on **Chrome, Safari and Firefox**, desktop and mobile.
Safari is the one that matters: it takes the MP4 branch of the recorder.

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IB1 | Invitation | Role → Candidates → Invite → one name + address | Email arrives; the link is `/s/{token}` |
| IB2 | Bulk invite | Paste 5 lines mixing `Name, email`, `Name <email>`, a bare address and one unreadable line | Shows "4 candidates ready" and the unreadable line **before** sending |
| IB3 | Duplicate invite | Paste the same list twice | No second session; the existing link is re-sent |
| IB4 | Welcome screen | Open the link | Greeting, role, question count, duration, and a **What you'll need** block (camera and microphone, a quiet place, keep the page open). The only secondary link is **Your data**, in the footer. No app navigation anywhere on the page |
| IB4b | Role language | Create a role in French, open its link in a browser set to English | The whole candidate surface is in French — welcome, check, interview, thank-you page and data page. It follows the role, not the browser |
| IB5 | Consent | Try to continue without ticking the box | Blocked. After ticking, `consentAcceptedAt` is set |
| IB6 | CV upload | Upload a PDF, then a `.txt` renamed to `.pdf` | First succeeds; second is refused on content type |
| IB7 | Device check | Deny camera permission | Explains how to allow it in the address bar — never a blank screen |
| IB7b | Camera busy or missing | Hold the camera in another app (a Teams or Meet call), or unplug the webcam, then open the check screen | The preview says **Audio only**; the interview records the voice alone with the same notice, and each answer saves with an audio object and no video. "Allow it in the address bar" is the wrong advice here and must not appear |
| IB7c | Chosen devices are used | On the check screen pick a second microphone, then continue | The interview URL carries `?mic=…`, and the recording is from the microphone picked — not the system default |
| IB8 | In-app browser | Open the link from the LinkedIn or Gmail mobile app | Warns that recording often fails there and suggests opening in Safari/Chrome |
| IB9 | Mic meter | Speak, then stay silent | Meter moves and reads "picking you up"; silence reads "can't hear anything" — and the **Start anyway** button is still available |
| IB10 | Record an answer | Start my answer → speak → I've finished my answer | The preview shows the candidate **throughout** the recording, never a black box — portrait on a phone held upright. Saving shows a percentage. Both an audio and a video object appear under `orgs/{orgId}/sessions/{sessionId}/q0.*` |
| IB11 | Time limit | Set a question to 30 s, then say nothing and wait | Countdown appears at 30 s remaining; recording stops on its own; the answer is saved |
| IB12 | **Network cut mid-answer** | Start an answer, disable the network, finish the answer | Shows "your last answer didn't save" with **Try again** and **Skip**. Re-enable the network → Try again → it uploads |
| IB12b | Video lost, answer kept | Throttle the network so the video upload fails after the audio one succeeded | The answer is saved and the next question shows "its video didn't get through — only the sound did". `sessionEvents` has an `upload_failed` row whose detail starts with `video:` |
| IB12c | Leaving mid-answer | Start an answer, switch to another app or tab (or unplug the headset), come back | Recording stopped when the page was hidden; what was said is saved, and the screen says so |
| IB13 | Resume | Close the tab after two answers, reopen the link | Resumes at question 3; the first two show as answered |
| IB13b | Resume after a skip | Q1 answered, Q2 fails to send → **Skip**, Q3 answered; close and reopen | The welcome screen says question **2**, the interview opens question 2, and after it moves to question 4 — question 3 is never offered again (`reserveSegment` answers `answered` for it and reserves nothing) |
| IB14 | Expiry | Set the role's expiry to yesterday, reopen the link | "This interview has closed" — never a dead end or a raw error |
| IB15 | Unknown token | Open `/s/aaaa…` (43 chars) and `/s/short` | Both give the **same** "This link doesn't work" — the candidate notice, never the back office's error card or a "Go home" to the landing page. Reloading `/s/{token}/interview` after finishing says "You've already completed this interview" |
| IB16 | Finish | Complete the interview | After the last question, a **Before you finish** screen lists any question without a saved answer, with a way back to it. Finish → thank-you page; session is `completed`; `jobLog` shows `transcribe · started`; the candidate receives **Your interview has been sent**, in the role's language, with a **See or delete my data** link to `/s/{token}/privacy`, logged in `emailLog` as `candidate-completed` |
| IB16b | Finish fails | Cut the network, then press **Finish the interview** | The error shows on the same screen, next to the button, and pressing it again once online completes the interview |
| IB17 | **A cancelled link cannot finish** | Mid-interview, cancel the session from the recruiter's candidate page, then press Finish in the candidate tab | The candidate sees the cancelled state; the session stays `cancelled`; no `jobLog` row, no report, no email. Same with the role archived instead |

## Interw C — Pipeline and report (15 min)

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IC1 | Transcription | After C16, watch the candidate page | Pipeline steps appear with timings; transcripts are written per segment |
| IC2 | Report | Wait for `report · succeeded` | Report appears: verdict, score, per-criterion scores, quotes |
| IC3 | **Evidence anchoring** | Click a quote's timestamp | The player switches to the right answer and seeks to the moment the quote was actually said — not to 0:00 |
| IC3b | **A quote that cannot be anchored** | Edit a transcript row so a report's quote no longer appears in it, reload the report | The quote is still shown, with **no** seek button. It must never fall back to the model's own estimate — a citation that lands on the wrong moment costs every other one its credit |
| IC10 | **A partial report** | Mark one uploaded segment `transcriptionState: 'failed'` before the fan-in completes | A report is still produced from the remaining answers, `reports.partial` is `true`, and exactly one recruiter email goes out. Before, the session froze with no report and no alert |
| IC11 | **Relaunching a stuck session** | `/app/admin` → Finished without a report → Relaunch | The session re-enters the pipeline: transcripts already taken are kept, answers that failed get another attempt, and a `relaunch` row appears in `jobLog` with the operator's `actorId`. The candidate page's pipeline trail shows step and outcome only, never `jobLog.error` |
| IC4 | Idempotent replay | Re-run `internal.pipeline.generateReport` for the same session via the Convex dashboard | Logs `report · skipped`, writes nothing, sends no second email |
| IC5 | Replay after killing a job | Delete the report row, re-run the chain | Produces a report again; no duplicate transcripts; no duplicate email |
| IC6 | Malformed model output | Temporarily set `EVALUATION_MODEL` in `convex/lib/ai.ts` to a model that ignores schemas, and push | The job **fails and retries**; no partial report is written |
| IC7 | Para-verbal | Open the Delivery panel | Six measured figures (rate, hesitation, silence, time used, consistency, speaking time). Deterministic — identical on a replay, and independent of the duration the browser reported: the length comes from `segments.measuredSeconds`, set at transcription |
| IC8 | Recruiter email | Check the inbox of a member of the role's org | "Report ready" with score and recommendation, and the caveat that it is automated |
| IC9 | Failed upload visible | Mark a segment `failed` by hand, open the report | That answer says the recording never reached us, explicitly as our failure |

## Interw D — Reports, sharing and decisions (10 min)

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| ID1 | Decision | Set Shortlisted, then click it again | Sets, then clears. Shows who decided and when |
| ID2 | Private note | Type a note, blur | Saved. Never appears on any candidate or shared surface |
| ID3 | Share link | Share → 7 days → Create | Link copied. Opening it in a private window shows the report |
| ID4 | Share withholds | On the shared page, search the HTML | No recruiter note, no candidate email, phone, LinkedIn, CV link, or internal role title |
| ID5 | Revoke | Revoke, reload the shared page | "This link was revoked". Playback URLs stop being issued |
| ID6 | Expiry | Create a link, set `expiresAt` to the past | "This link has expired" |
| ID6b | **Expiry with a hostile clock** | Against the same expired link, call the deployment directly: `shares:view {token, now: 0}`, then `shares:sharedMediaUrls {token, now: 0}` | Both answer `expired` / `[]`. `now` is the viewer's clock and the viewer is whoever holds the link; it keeps the expiry visible without polling, and decides nothing. Same for `interview:questions` on a closed role |
| ID6c | Unresolved tokens never reach the limiter | Call `shares:recordView` with 40 random tokens | Each returns `null`; the share's `viewCount` is unchanged and no rate-limiter row is written for them — the bucket is keyed on the resolved share |
| ID7 | Search | ⌘K, type three letters of a candidate's name | Finds them across roles. A member who cannot see a restricted role does **not** see its candidates here |
| ID8 | **Removal ends access** | Share a restricted role with member B, have B create another role, remove B, complete an interview on each, re-invite B as a plain member | B receives no "report ready" email while removed, and after re-invite does **not** see the restricted role (its share row went with the membership) |
| ID9 | Restore is admin-tier | As a plain member who did not create it, restore an archived role | Refused (`insufficient_role`), stays archived. Owner, admin and the role's creator succeed — same tier as Archive |
| ID10 | Deliverability respects restricted roles | As a member not named on a restricted role, call `emailEvents:recent {orgId}` | No row for a candidate of that role |

## Interw E — Retention and erasure (10 min)

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IE1 | Candidate self-delete | Open `/s/{token}/privacy` → Delete everything | Every object under `orgs/{orgId}/sessions/{sessionId}/` is gone from the bucket; session, segments, transcripts, report, shares **and `emailLog` rows** are gone; one `purgeLog` row exists carrying a **salted hash** (P4b), not the address. The page ends on **Your data has been deleted** — never an error screen |
| IE2 | Recruiter delete | Candidate page → Delete this candidate's data | Same outcome, `reason: recruiter_delete` |
| IE3 | Retention purge | Set a completed session's `purgeAfter` to the past, run `internal.retention.purgeDueSessions` | Media objects deleted; the report and transcript **remain**; `mediaPurgedAt` set and `purgeAfter` **kept**; the report page says the recordings were deleted |
| IE3b | The purge is not blocked by clockless sessions | Leave 40+ `pending` sessions on the deployment, then run IE3 | The due session is still found. An absent `purgeAfter` sorts before every value in a Convex index, so a range bounded only from above used to spend the whole batch on sessions with no clock at all and purge nothing, silently, forever |
| IE6 | An abandoned application expires too | Invite a candidate, do not open the link, read the row | `purgeAfter` is set at the invitation, six months out — not only at `finish`. Most invitations are never opened, and those are the records hardest to justify keeping |
| IE7 | Deleting a role takes its media | Record an intro and a question prompt on a role with no candidates, delete the role | Both objects are gone from the bucket, not just the rows |
| IE3c | One failing session does not block the purge | Make one due session's object undeletable (e.g. a bucket policy denying that key), then run IE3 with other due sessions behind it | The others are purged in the same pass; the failing one gets a `purge · failed` row in `jobLog`, a `retention_purge_failed` log line, and its `purgeAfter` pushed a day out so it no longer heads the next batch |
| IE4 | Purge is replayable | Run the purge twice | Second pass is a no-op, not an error |
| IE5 | No orphans | After G1, list the bucket prefix | Empty. Including any answer whose upload had failed — those keys are written before the upload for exactly this reason |
| IE8 | **A re-recorded answer is erased too** | Record Q1 in Chrome (webm), cut the network before it is marked uploaded, resume in Safari (mp4) and finish, then Delete everything | Both `q0.weba`/`q0.webm` and `q0.m4a`/`q0.mp4` are gone from the bucket — the replaced keys stay named in `segments.supersededKeys` until erasure |
| IE9 | Assistant threads go with the candidate | Ask the assistant for candidate X's report, keep the panel open, then delete X from another tab | The conversation disappears; the panel switches to the latest remaining thread (or the empty state) and the page does not crash. A conversation that never read X stays. `chatThreadSessions` has no row for the erased session |
| IE10 | Resend copies expire | Convex dashboard → Crons | "remove old emails from the resend component" runs hourly; in the resend component's tables, no email is older than 30 days |

---

## Quick dev seed

To save ~2 min of setup, a dev seed (called via `convex run`) can create
Alice (SA), Bob (member), an "acme" org, and a role with 3 questions. Write it in
`convex/admin.ts` as an `internalMutation` named `seedDev`, gated behind
`process.env.CONVEX_DEPLOYMENT !== 'production'`.

## Failure recovery

- Smoke fails → open `KNOWN_ISSUES.md` (Convex deployment / `pnpm rebuild esbuild`).
- Auth fails → check `BETTER_AUTH_SECRET` + `SITE_URL` on the Convex env.
- Emails not received → valid `RESEND_API_KEY` + `RESEND_TEST_MODE=false` to
  actually deliver.
- AI not streaming → `MISTRAL_API_KEY` + check `convex/agent.ts` (same
  provider and model as the pipeline, from `convex/lib/ai.ts`).
- Upload gives 403 → the presigned URL signs `content-type` **and**
  `content-length`. The client must send both exactly as issued; `fetch` does
  this automatically for a `Blob`, a hand-rolled request may not.
- Upload gives `SignatureDoesNotMatch` → check `OBJECT_STORE_REGION` and
  whether the provider needs path-style addressing
  (`OBJECT_STORE_FORCE_PATH_STYLE=true`, for MinIO in local development).
- Pipeline stuck → read `jobLog` for that session (it is also shown on the
  candidate page). Every step records started / succeeded / failed / skipped
  with a duration and the error.
- Report never generated but transcripts exist → `generateReport` skips when
  the role has no criteria. Add one and re-run the chain.
- Quotes jump to 0:00 → the transcript has no timestamps, so anchoring fell
  back to the model's estimate. Check that Mistral returned `segments`, which
  requires `timestamp_granularities`.
