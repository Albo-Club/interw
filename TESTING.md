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
  - `ANTHROPIC_API_KEY` (default model: `claude-haiku-4-5`)
- `.env.local` filled in (`VITE_CONVEX_URL`, `CONVEX_DEPLOYMENT`)
- 2 browsers (or 1 browser + 1 incognito window) ready for multi-tenant tests

## Level 0 — Before the first run (one-off, ~20 min)

Nothing below Level 1 works without these, and the first one cannot be
undone later.

| #  | Step | How | Why it matters |
| -- | ---- | --- | -------------- |
| P1 | **Create the Convex project in EU West (Ireland)** | Choose the region in the Convex dashboard when the project is created, and set the team default so preview deployments follow | The region is fixed at creation. Changing it later means a new deployment and an export/import migration. Candidate video is the most sensitive data this product holds |
| P2 | Private S3-compatible bucket | Scaleway Object Storage, region `fr-par`, bucket **not** public. Set `OBJECT_STORE_*` on the Convex deployment (see `.env.example`) | Every object is served through a signed URL minted after an access check. A public bucket silently defeats all of it |
| P3 | Verify the bucket is private | `curl -I https://<bucket>.<endpoint>/probe.txt` on an object you uploaded | Must be `403`. A `200` means every candidate recording is world-readable |
| P4 | Model provider keys | `MISTRAL_API_KEY` (transcription) and `OPENROUTER_API_KEY` (evaluation) on the Convex deployment | The pipeline fails at the first step without them, visibly, in `jobLog` |
| P5 | Resend delivery webhook | Point a Resend webhook at `https://<convex-site-url>/resend-webhook`, store `RESEND_WEBHOOK_SECRET` | Without it a bounced invitation is indistinguishable from a candidate who has not opened it |
| P6a | `MEDIA_ORIGIN` on the **web server** (Vercel project env, or `.env.local` for `pnpm dev`) | The bucket origin signed URLs point at, e.g. `https://interw-media.s3.fr-par.scw.cloud` | The CSP is served by the web server, which never talks to the bucket, so this is the one object-store setting that does not live on the Convex deployment. Unset, `media-src` falls back to `https:` — video still plays, but from any host |
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
| B7 | Unit + integration tests | `pnpm test` | All suites pass. Covers SigV4 against AWS's own vectors, weight normalisation, the session gate, the candidate projections, evidence anchoring, the report builder, para-verbal metrics, locale parity, and cross-organisation isolation under `convex-test` |
| B8 | Convex codegen committed | `pnpm codegen:api:check` | `convex/_generated/api.d.ts is up to date.` Fails when a Convex module was added without committing its codegen — CI has no deployment, so `npx convex dev` cannot do it there |
| B9 | Access audit | `pnpm audit:access:check` | Exit 0. Fails on any **public** Convex function with no access check. Run `pnpm audit:access` to print the full matrix; deliberate exceptions are declared with a `// access: <reason>` comment above the export and are listed in the output |

B2–B3, B6, B6b, B7, B8 and B9 also run in CI on every PR (`.github/workflows/ci.yml`,
B6 via the `skills-verify` job, B6b via `skills-drift`). CI covers B0
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
| A6  | Magic link for registered + unregistered email         | Identical privacy-respecting toast. No `users` row created for unknown email.     |
| A7  | Forgot → reset chain (email → token → new password)    | Sign-in with new password works. All pre-reset sessions invalidated.              |
| A8  | `/reset-password?token=expired` (or no token)          | Card "Invalid or expired link" + primary CTA "Send a new reset link"              |
| A9  | `/register` with already-registered email              | **Same** "Check your inbox" screen as a new signup (anti-enumeration), no email sent |
| A10 | Rate-limit (sign-in 6×, sign-up 4×, magic 4× /60s)    | "Too many attempts…" toast via classifier (no raw BA message)                     |
| A11 | `/app/me` → change email                               | **Approval email** arrives at the **current** address (anti-takeover), not the new one |
| A12 | Password constraints (`/register` + `/reset-password`) | <12 chars → Zod block. HIBP leak → "appeared in known data breaches". zxcvbn meter visible. |
| A13 | Password match feedback `/reset-password`              | Match → green ✓ "Passwords match". Mismatch → red case-sensitive hint.           |
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

## Level 5 — AI panel (10 min)

| #   | Step                                                    | Expected result                                                   |
| --- | ------------------------------------------------------- | ----------------------------------------------------------------- |
| C1  | Open `/app/acme`                                        | AI panel open by default in its rounded box (desktop right column); latest thread resumed, else empty state with suggestions |
| C1b | Press ⌘J / Ctrl+J (or the header AI button), then reload | Panel toggles; state persists across reload (cookie `ai_panel_state`) |
| C2  | Send a simple message ("ping")                          | Stream visible token by token; "Thinking…" before first token; no UI blocking |
| C2b | Ask for a formatted response ("bullet list + bold")     | Markdown rendered via streamdown (bullets, bold, inline code, tables) |
| C3  | Ask the agent "list my open roles" (an empty-state suggestion) | `listRoles` runs (read-only, no approval), collapsible tool call, response lists Acme roles |
| C4  | Ask it to reject a candidate, invite someone, or change a role | It refuses and points at where to do it in the app. **Every tool is read-only** — a hiring decision is never a tool call |
| C5  | While a long answer streams, click **Stop**             | Generation aborts                                                 |
| C6  | Spam 30 messages in 1 min                               | `chatSend` rate-limit triggers (also gates approvals)             |
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
| IA2 | Questions | Wizard → Questions → add three, edit the text, reorder with the arrows | Order persists on reload; indices stay contiguous |
| IA3 | Record a question | Questions → Record this question → speak → Stop | Uploads, then shows **Recorded**. Check the object exists in the bucket under `orgs/{orgId}/projects/{projectId}/q-{questionId}.*` |
| IA4 | Re-record | Record again with a different browser (WebM vs MP4) | The old object is deleted, not orphaned. Exactly one `q-{questionId}.*` remains |
| IA5 | Criteria and weights | Add three criteria with weights 10 / 10 / 10 | Each shows **34% / 33% / 33%** — never 33/33/33 |
| IA6 | Publish gate | Try to publish with no question | Refused with "Add at least one question" |
| IA7 | Import a job ad | Questions → Import from a job ad → paste a real published ad URL | Draft appears with the requested number of questions and criteria summing to 100. **Nothing is saved** until "Add all to the role" |
| IA8 | Import SSRF guard | Paste `http://127.0.0.1:8080/` and `http://169.254.169.254/` | Both refused as "not a public web address" |
| IA9 | Restrict a role | Share → name one colleague → Save | A different member (non-admin) no longer sees the role in the list, in search, or by URL — and gets **not found**, not "forbidden" |
| IA10 | Archive | Archive an active role | Becomes read-only; editing is refused; restoring returns it to **Draft**, never straight to Active |

## Interw B — Candidate journey (20 min, repeat per browser)

Run the whole level on **Chrome, Safari and Firefox**, desktop and mobile.
Safari is the one that matters: it takes the MP4 branch of the recorder.

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IB1 | Invitation | Role → Candidates → Invite → one name + address | Email arrives; the link is `/s/{token}` |
| IB2 | Bulk invite | Paste 5 lines mixing `Name, email`, `Name <email>`, a bare address and one unreadable line | Shows "4 candidates ready" and the unreadable line **before** sending |
| IB3 | Duplicate invite | Paste the same list twice | No second session; the existing link is re-sent |
| IB4 | Welcome screen | Open the link | Greeting, role, question count, duration, what is needed. No app navigation anywhere on the page |
| IB5 | Consent | Try to continue without ticking the box | Blocked. After ticking, `consentAcceptedAt` is set |
| IB6 | CV upload | Upload a PDF, then a `.txt` renamed to `.pdf` | First succeeds; second is refused on content type |
| IB7 | Device check | Deny camera permission | Explains how to allow it in the address bar — never a blank screen |
| IB8 | In-app browser | Open the link from the LinkedIn or Gmail mobile app | Warns that recording often fails there and suggests opening in Safari/Chrome |
| IB9 | Mic meter | Speak, then stay silent | Meter moves and reads "picking you up"; silence reads "can't hear anything" — and the **Start anyway** button is still available |
| IB10 | Record an answer | Start my answer → speak → I've finished my answer | Both an audio and a video object appear under `orgs/{orgId}/sessions/{sessionId}/q0.*` |
| IB11 | Time limit | Set a question to 30 s, then say nothing and wait | Countdown appears at 30 s remaining; recording stops on its own; the answer is saved |
| IB12 | **Network cut mid-answer** | Start an answer, disable the network, finish the answer | Shows "your last answer didn't save" with **Try again** and **Skip**. Re-enable the network → Try again → it uploads |
| IB13 | Resume | Close the tab after two answers, reopen the link | Resumes at question 3; the first two show as answered |
| IB14 | Expiry | Set the role's expiry to yesterday, reopen the link | "This interview has closed" — never a dead end or a raw error |
| IB15 | Unknown token | Open `/s/aaaa…` (43 chars) and `/s/short` | Both give the **same** "This link doesn't work" |
| IB16 | Finish | Complete the interview | Lands on the thank-you page; session is `completed`; `jobLog` shows `transcribe · started` |

## Interw C — Pipeline and report (15 min)

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IC1 | Transcription | After C16, watch the candidate page | Pipeline steps appear with timings; transcripts are written per segment |
| IC2 | Report | Wait for `report · succeeded` | Report appears: verdict, score, per-criterion scores, quotes |
| IC3 | **Evidence anchoring** | Click a quote's timestamp | The player switches to the right answer and seeks to the moment the quote was actually said — not to 0:00 |
| IC4 | Idempotent replay | Re-run `internal.pipeline.generateReport` for the same session via the Convex dashboard | Logs `report · skipped`, writes nothing, sends no second email |
| IC5 | Replay after killing a job | Delete the report row, re-run the chain | Produces a report again; no duplicate transcripts; no duplicate email |
| IC6 | Malformed model output | Temporarily point `OPENROUTER_API_KEY` at a model that ignores schemas | The job **fails and retries**; no partial report is written |
| IC7 | Para-verbal | Open the Delivery panel | Six measured figures (rate, hesitation, silence, time used, consistency, speaking time). Deterministic — identical on a replay |
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
| ID7 | Search | ⌘K, type three letters of a candidate's name | Finds them across roles. A member who cannot see a restricted role does **not** see its candidates here |

## Interw E — Retention and erasure (10 min)

| #  | Scenario | Steps | Expected |
| -- | -------- | ----- | -------- |
| IE1 | Candidate self-delete | Open `/s/{token}/privacy` → Delete everything | Every object under `orgs/{orgId}/sessions/{sessionId}/` is gone from the bucket; session, segments, transcripts, report and shares are gone; one `purgeLog` row exists carrying a **hash**, not the address |
| IE2 | Recruiter delete | Candidate page → Delete this candidate's data | Same outcome, `reason: recruiter_delete` |
| IE3 | Retention purge | Set a completed session's `purgeAfter` to the past, run `internal.retention.purgeDueSessions` | Media objects deleted; the report and transcript **remain**; `mediaPurgedAt` set; the report page says the recordings were deleted |
| IE4 | Purge is replayable | Run the purge twice | Second pass is a no-op, not an error |
| IE5 | No orphans | After G1, list the bucket prefix | Empty. Including any answer whose upload had failed — those keys are written before the upload for exactly this reason |

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
- AI not streaming → `ANTHROPIC_API_KEY` + check `convex/agent.ts` (default
  model `claude-haiku-4-5`).
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
