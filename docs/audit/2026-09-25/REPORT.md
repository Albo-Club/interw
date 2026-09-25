# Security audit report — interw (Albo-Club/interw), T17

## 1. Run summary

- **Run**: interw-T17-2026-09-25. A read-only review of the code written after the 2026-09-22 audit
  (base `9a70f3f`).
- **Source**: branch `claude/audit-T16-docs` at `e639fd9`. Its merge-base with `origin/main` is
  `506e527`.
- **Scope, in priority order**:
  1. The T01–T16 stack, diffed against `origin/main`.
  2. What was merged on main since `9a70f3f`: #28, #29, #30 and #31.
  3. The CI `e2e` job.
  4. Coverage gaps 1 and 2 from the 2026-09-22 report.
- **Execution policy**:
  - Source and local only. No deployment, provider or GitHub Actions run was contacted, and no
    environment value was read or printed.
  - `node_modules` was present, so `better-auth@1.6.30`, `@convex-dev/better-auth`,
    `@convex-dev/resend` and `@convex-dev/rate-limiter` were read directly.
- **How findings were reproduced**:
  - One throwaway `convex-test` suite ran the real handlers. Only `./auth` (who is calling) and
    `./email` (to capture sent mail) were mocked, as the repository's own suites do. The suite was
    deleted afterwards and no test file is committed.
  - The access-audit script was run unmodified against a scratch fixture tree.
- **Out of scope**: the open PRs outside the stack (#36, #37, #38, #40, #42). Several of them touch
  auth and need their own pass before merge.

## 2. Security posture

The code written since the audit closes most of what the 2026-09-22 audit found:

- `finish` now checks the session gate.
- The HTTP chat route is gone.
- `removeMember` revokes team rows and share links.
- Media and document keys are derived on the server and compared against the exact set that could
  have been issued.
- `sessionEvents` is written through one capped function.
- The duration the client reports is clamped and is no longer used as a measurement.
- The job-ad fetch connects only to the addresses it checked, and its parser runs in linear time.
- Erasure now reaches the copies held by the Resend and Agent components.
- The #28 hook closes the verify-email pre-hijack. It matches on `ctx.path`, which is the endpoint
  path, so a path variant cannot skip it.
- T04 holds against direct calls. Every org-scoped read goes through `canSeeProject` or
  `filterVisibleProjects`.
- The T13 fixtures are internal and switched on per deployment.
- A pull request from a fork cannot reach the deploy key.

What remains is the same second-tier pattern as last time: a rule is written down in one place and a
sibling code path does not follow it. The access-audit script is reliable for the export shapes this
codebase uses today, but its summary line claims more than it checks, and T17-4 sits in one of its
blind spots.

## 3. Confirmed findings

5 findings, all LOW. None is cross-tenant and none bypasses authentication.

| Severity | Title | Boundary | Observed |
|---|---|---|---|
| low | Candidate emails use the internal title as a fallback | `candidateView` projection vs. the email templates | `landing.jobTitle` is null, but the invitation subject and the completion email body both carry the internal title (e.g. "Replace Paul (do not tell him) - budget 55k") |
| low | Creator status outlives the membership | The `createdBy` shortcut vs. `revokeMemberGrants` | After removal: `not_a_member`. After re-invite as a plain member: `getBySlug` returns the role, `invitationLink` returns the candidate's link, `canManage` is true |
| low | Slug oracle for roles the caller cannot see | T04 "invisible means `not_found`" | Creating "Replace Paul" returns `replace-paul-2`; creating "Replace Jane" returns `replace-jane` |
| low | The rate limiter is spent before the token is checked | Resolve the token first, then limit | 32 `promptMediaUrls` calls with a well-formed token that matches no session: 30 `not_found`, then 2 `rate_limited` |
| low | A CV is uploaded before any row names it | "Named before upload" erasure rule | After the slot is issued: a PUT for `…/cv.pdf` valid 900 s, `cvKey` null, erasure set `[]`. After `attach(msword)`: erasure set `["cv.doc"]`, and `cv.pdf` is named nowhere |

### LOW T17-1 — Candidate emails fall back to the internal title

- **Where it happens**: `convex/sessions.ts:209` and `convex/interview.ts:662` pass
  `project.jobTitle ?? project.title` to `candidateInvitationEmail` (subject and body) and to
  `candidateCompletedEmail` (added by #30).
- **Rule it breaks**:
  - T10 removed this same fallback from share links. The comment at `shares.ts:266-268` says the
    candidate is not shown the internal title either.
  - `toCandidateProjectView` (`lib/candidateView.ts:71`) returns `jobTitle ?? null`.
  - `jobTitle` is optional, so every role created without one mails its internal label to every
    candidate.
- **Impact**: a recruiter's private label (names, budget, reason for the hire) reaches the person
  being assessed. Likelihood medium, impact low.
- **Fix**:
  - Pass `jobTitle ?? null` from both call sites.
  - Let both templates accept null and fall back to "your interview with {org}". Alternatively,
    block publishing a role without a `jobTitle`.
  - Add a regression test that no email to a candidate contains `project.title`.
- **Task**: "Candidate emails use the public job title only".

### LOW T17-2 — Creator status outlives the membership

- **Where it happens**:
  - `removeMember` calls `revokeMemberGrants` (`lib/projectAccess.ts:145-174`), which deletes
    `projectShares` rows and revokes share links.
  - It cannot remove `projects.createdBy`, the creator's implicit seat on the team.
  - When the person is re-invited, `canSeeProject` returns true at `:39`.
    `requireProjectOwnerOrAdmin` at `:103` then also unlocks the owner-tier actions:
    `invitationLink`, `cancel`, `deleteCandidateData`, `archive`, `remove`, `setTeam`, `relaunch`.
- **Rule it breaks**: `notifications.ts:94-95` says `createdBy` is an attribution, "never a grant
  that outlives removal".
- **Impact**: a former member re-admitted as a plain member silently gets back every role they
  created, including candidate data and the candidates' own interview links. Likelihood low.
- **Fix**:
  - Store the creator as a `projectShares` row when the role is created, and drop the `createdBy`
    shortcut from `canSeeProject`, `filterVisibleProjects`, `requireProjectOwnerOrAdmin` and
    `sendReportReady`.
  - Migrate existing roles with one row per `createdBy`.
  - Add a regression test: remove the creator, re-invite them as a member, and expect `not_found`.
- **Task**: "Creator seat revoked with the membership".

### LOW T17-3 — Slug de-duplication reveals hidden roles

- **Where it happens**: `projects.ts:196-205` runs `uniqueSlug` over `by_org_and_slug` across every
  role in the org, including roles hidden from the caller. `slug.ts:34-45` adds a `-N` suffix, and
  the new slug is returned to the caller (`:230`).
- **Rule it breaks**: `projectAccess.ts:9-11`: a recruiter "should not learn that a confidential
  role exists". Since T04 made every role team-only, this applies to every role in the org.
- **Impact**: any member can confirm that a role exists and learn its title as a slug. The suffix
  number also shows how many hidden roles share that title root. No candidate data is exposed.
- **Fix**: add a short random or id-derived suffix to every new slug, and add a regression test
  that the result does not depend on hidden roles.
- **Task**: "Slugs independent of hidden roles".

### LOW T17-4 — `consumeWriteLimit` keys the limiter on an unchecked token

- **Where it happens**:
  - `candidate.ts:292-299` only checks that the string looks like a token, then calls
    `consumeLimit('candidateWrite', token)`.
  - The component keeps one durable row per key, with no expiry.
  - The call runs before the token is resolved in `promptMediaUrls` (`interview.ts:262`),
    `requestDocumentUpload` (`candidate.ts:272`) and `deleteMyData` (`:396`).
- **Rule it breaks**: lead 4 (`recordView`) and T10 (`resolveSharedMedia`: "an unresolved token
  writes nothing"). The access-audit script cannot see this (§6.2).
- **Impact**: anyone, with no token and no account, can create limiter rows under keys they choose,
  and those rows are never removed. The cost is operator storage only.
- **Fix**:
  - Replace the call with an internal mutation that runs `requireSession` first, then consumes on
    `session._id`.
  - Key `candidateWrite` on `session._id` everywhere.
  - Add a regression test: 32 calls with an unresolved token all return `not_found`.
- **Task**: "Candidate limiter keyed on the resolved session".

### LOW T17-5 — CV and cover-letter objects are written before any row names them

- **Where it happens**:
  - `requestDocumentUpload` (`candidate.ts:260-289`) signs a PUT for `…/cv.{ext}`, valid 900 s.
  - The row is only updated later, by `attachDocument` → `swapDocumentKey` (`:320`), with the key
    derived from the type named at attach time.
  - Erasure deletes only the keys that rows name (`purge.ts:64-74`); it never lists the bucket.
  - So a CV stays in the bucket with no row naming it in two cases:
    - the upload succeeded but `attach` never ran (tab closed, network drop);
    - `attach` named a different file type than the one uploaded.
- **Rule it breaks**: CLAUDE.md, Erasure: "written before its upload, carrying the keys". Segments
  follow it since T01; documents never did.
- **Impact**: a CV full of personal data can survive `deleteMyData`, recruiter deletion and
  retention, while the candidate is told everything was erased. Nothing is disclosed: the bucket is
  private.
- **Fix**:
  - Record the issued key on the session (`pendingDocumentKeys`) before signing the upload URL.
  - Have `collectSessionObjects` include those keys.
  - Move the key out of that list when `attach` succeeds.
  - Apply the same pattern to the recruiter's intro and question media.
  - Add a regression test: issue a slot, never attach, erase, and expect the issued key among the
    deleted objects.
- **Task**: "Document keys named before upload".

## 4. Needs validation (no severity)

| # | Lead | Trace | Blocker | Owner check |
|---|---|---|---|---|
| V1 | The e2e job deploys any same-repo PR branch with `CONVEX_DEPLOY_KEY`, without checking which deployment the key names | `ci.yml:3-6`, `:58-87`; `package.json:15` | Which deployment the GitHub secret names. If it holds the production key (the local environment's key is production), every PR deploys unreviewed functions to production | Confirm it is a staging key, by comparing deployment names in the Convex dashboard (never print the key) |
| V2 | PRs from branches in this repo, including Renovate's, run the build chain with the key in the job env before any human review | `ci.yml:65-68`; `renovate.json:15-20` | Whether Renovate is installed, and whether `minimumReleaseAge` delays the branch or only the automerge | Check the installed GitHub Apps; compare a Renovate PR's branch creation time with the package's publish time |
| V3 | 09-22 lead 3: which client IP Better Auth's rate limit keys on | The proxy copies every header (`react-start/index.js:38-47`); no `advanced.ipAddress` (`auth.ts:139-145`) | Whatever Convex ingress does with `X-Forwarded-For` (pass through, append or overwrite), each outcome weakens the limit differently | Staging test: 6 wrong passwords through the app, then 6 direct with varying XFF. Set `advanced.ipAddress` and a per-account limit regardless |
| V4 | Signed bucket URLs in Sentry breadcrumbs | `upload.ts:68-85`; the scrubber only masks `/s/` and `/r/` | Whether Sentry 10's XHR breadcrumbs keep the query string | Inspect one real candidate-side error event |
| V5 | The Playwright report artifact may contain signed URLs or the seeded token | `playwright.config.ts:13`; `ci.yml:90-94` | Repo visibility; what a failed run's trace keeps | Search one failed run's artifact for `X-Amz-Signature` and `/s/` |
| V6 | Erasure deletes a chat thread while a stream may still be writing to it | `purge.ts:131-145`; `recruiterTools.ts:40-56` | How the agent component handles writes to a deleted thread | Read the component's source, then a convex-test race |
| V7 | On a proxied error, `/api/auth` logs `request.url`, which carries magic-link, verify or reset tokens | `src/routes/api/auth/$.ts:36` | Whether those endpoints ever throw instead of returning a 4xx; how long Vercel keeps logs | Search the Vercel logs for `[ts-auth-handler] url=` |

## 5. Hardening notes and positive patterns

- **CI**:
  - Move the three secrets into a `staging` GitHub Environment with branch rules.
  - Pass them only to the deploy and e2e steps, not the whole job.
  - Assert the deployment name against a non-secret `STAGING_DEPLOYMENT`. That turns V1 into a CI
    failure.
- **Fork PRs are safe**: the workflow uses `pull_request`, not `pull_request_target`, so a fork gets
  no secrets.
- **The T13 gate is sound**: `convex/e2e.ts:39,130` are internal and switched on per deployment.
- **T07 is sound**: relaunch is limited to creator/owner/admin, rate-limited, refused while a report
  exists, and logged. Consider refusing a relaunch once `mediaPurgedAt` is set.
- **T04 dashboard**: the `capped` flags are computed over unfiltered, org-wide scans. Filter first,
  then cap.
- **T04/T09**: after a member leaves a role's team, their assistant threads still hold that role's
  data. Erase the linked threads on team removal.
- **T10**: a member's share links survive their removal from a role's team. Revoke them in
  `writeTeam`.
- **Pre-existing**: `questions.create`, `criteria.create` and `applyDraft` add to live roles without
  `requireNoSessions`. That is product integrity, not security.
- **Already sound**:
  - T14 `applyDraft`: guarded, every row validated, one transaction.
  - #31: resolves and checks each hop, fails closed, connects only to the pinned addresses, caps the
    body. The IPv4 deny list could add 198.18/15 and 192.0.0/24.
  - #29: the Resend cleanup reschedules itself until done, and copies live 30 days at most.
  - #28: matches the endpoint path; the sign-in branch requires a signed JWT, a matching email and a
    password that verifies.
  - #30: keeps nothing in browser storage, and the server re-checks every step. One gap: a segment's
    PUT URL stays valid up to 13 min after it is marked uploaded, so the object can be overwritten
    with bytes of the same length. Record the ETag if that matters.
- **Positive patterns**:
  - Identical failure for every unresolved token.
  - Projectors plus `returns` validators on the candidate surface.
  - The org is read off the row, never from an argument.
  - Keys are checked against the exact set that could be issued.
  - One capped event writer.
  - `effectiveNow` on reactive clocks.
  - Membership re-checked at send time.
  - A shared `revokeMemberGrants`.
  - Actions pinned by SHA, and `pnpm audit --prod` in CI.

## 6. Coverage summary

| Status | Units |
|---|---|
| covered, no finding | 13 |
| confirmed | 5 |
| needs validation | 7 |
| out of scope | 1 (the non-stack PRs) |

**Rejected candidates**:
- A #28 bypass through a path alias.
- The T13 fixtures being callable from a client.
- A fork PR reaching the deploy key.
- `emailEvents.recent` leaking hidden roles: it filters row by row since T11.

### 6.1 Gap 1 — Better Auth on `convex.site` and the `/api/auth` proxy

- **Routes**: `registerRoutes` (`http.ts:8`) serves `/api/auth/*` with the same `createAuth` as the
  app. The limits, the verify hook and the cookie settings are therefore identical on both origins.
- **CORS**: no `cors` option is passed, so responses carry no CORS headers, and a page on another
  origin cannot read them.
- **Cookies**:
  - They use the `interw` prefix, `lax`, `httpOnly`, and `secure` in production.
  - A cookie set by `convex.site` is never sent to the app, so login CSRF there gives no usable
    session.
  - Every emailed link uses `SITE_URL`.
- **Origin**: `trustedOrigins` only protects browsers. Against a direct caller, the rate limit (V3)
  and the password are the only controls.
- **Forwarded-host headers**: `x-better-auth-forwarded-*` can be set by a direct caller, with no
  effect while `baseURL` stays static.
- **X-Forwarded-For**: see V3. Fix it now; the fix does not need to wait for the observation.

### 6.2 Gap 2 — `scripts/audit-convex-access.mjs` after T15

T15 fixed real weaknesses: it now reads the TypeScript AST, matches guards as calls, strips
comments, counts limiter writes, and audits `http.route`. On the current tree it reports "100
public, 0 unguarded", which is correct as far as this review found.

I ran the unmodified script against a scratch fixture tree. It flagged the control and exited with
code 2, but it missed the following.

**Invisible to the script** (never listed, so never failed):
- `export { f }`
- `export default mutation(...)`
- an aliased builder (`mutation as m`)
- `.js` modules
- anything in a `SKIP` file

Today `publicConfig.enabledSocialProviders` is public and silently missing from the report.

**Passes while writing before its guard**:
- a write, then a call to a guarded helper (the order is only checked for a direct guard call,
  `:344`);
- `deleteObjects` before delegating to a guarded function;
- `ctx.storage.delete` before `requireAppUser`;
- a guard in dead code.

**Unguarded internal mutation before the delegated guard**: this is exactly T17-4.

**Verdict**: treat the script as a tripwire for the usual shape only. Its summary does not mean "no
effect runs before a guard".

**Tighten (task T17-6)**:
1. Enumerate the public functions from `_generated/api.d.ts` and fail on any that were not
   classified.
2. Replace `SKIP` with per-export `// access:` markers.
3. Check the order on helper and delegation paths too.
4. Add storage, object-store, email, `runAction` and unguarded `runMutation(internal.*)` calls to
   `WRITES`.
5. Add `withIdentity` tests for T17-2 and T17-3.

## 7. Tasks for the next night

1. T17-1: candidate emails use the public job title only.
2. T17-2: creator seat revoked with the membership (creator stored as a team row).
3. T17-3: slugs independent of hidden roles.
4. T17-4: candidate limiter keyed on the resolved session.
5. T17-5: document keys named before upload.
6. T17-6: tighten the access-audit script.
7. CI hardening: a `staging` Environment, secrets scoped to steps, deployment-name assertion (V1,
   V2).
8. V3: `advanced.ipAddress` plus a per-account sign-in limit. Fold into T12, still pending on the
   auth PRs.
