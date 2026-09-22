# Architecture summary — interw (HEAD 9a70f3f, clean worktree)

## 1. Product, principals, authority, protected resources

Interw is an asynchronous video-interview SaaS. A recruiter organisation records questions, invites candidates by email, the candidate answers once from the browser, and every interview is transcribed and scored by a model against recruiter-set criteria (README.md:1-20). Three surfaces: recruiter app `/app/{orgSlug}/**`, candidate journey `/s/{token}/**` (token, never an account), shared report `/r/{shareToken}`.

Principals, lowest trust first:
- **Anonymous visitor**: auth pages, Better Auth (BA) HTTP routes proxied at `src/routes/api/auth/$.ts`, public Convex queries `organizations.checkSlug`, `invitations.preview`, `publicConfig.enabledSocialProviders`, and `POST /resend-webhook` (Svix-signed inside `@convex-dev/resend`).
- **Candidate holding a session access token** (32 CSPRNG bytes, `convex/lib/tokens.ts`): `convex/candidate.ts` and `convex/interview.ts`, resolved via `by_token`; every unresolved token fails identically; rows never returned, only projectors in `convex/lib/candidateView.ts` with runtime `returns` validators.
- **Share-link holder**: `convex/shares.ts` `view`/`recordView`/`sharedMediaUrls` via `resolveShare`.
- **Org invitee**: `invitations.preview/accept` and the BA signup hook that pre-verifies an email when `inviteToken` matches (`convex/auth.ts:183-211`).
- **Registered user without org**: can create an org (becomes owner), edit profile, upload avatar.
- **Org member / admin / owner**: `requireOrgMember`/`requireOrgRole` (`convex/lib/auth.ts:107-132`); project visibility layer (`restricted` + `projectShares`, `convex/lib/projectAccess.ts`); any visible member can edit projects, invite candidates, set decisions, create share links, chat with the agent; creator-or-admin for destructive actions.
- **Super admin** (`users.superAdmin`; first provisioned user): cross-org read, `setSuperAdmin`, `relaunchSession`.
- **Internal**: cron `retention.purgeDueSessions` every 6 h, two workpools (transcription, report), scheduled email batches, `chat.streamAsync`.

Protected resources: candidate video/audio and documents in a private S3-compatible bucket (keys only in DB, URLs signed at read time, 1 h GET / 15 min PUT, `convex/lib/objectStore.ts`), transcripts and AI reports, candidate PII (name, email, phone, LinkedIn), org membership and roles, session/share/invitation tokens, provider credentials (Mistral, Anthropic, Resend, object store) held only in the Convex deployment env.

## 2. Comparable baseline

The only source-grounded comparable is the upstream starter `Albo-Club/albo-ouvre-boite` v0.3.0 (TanStack Start + Convex + Better Auth multi-tenant template). No competing async-interview product is named anywhere. The starter accepts permanent unauthenticated Convex storage URLs for avatars/logos and a CSP with `'unsafe-inline'` scripts; Interw inherits both and deliberately moved candidate media out of Convex storage for that reason.

## 3. Stack, deployment paths, offline limits

TypeScript strict; React 19; TanStack Start 1.168 / Router 1.170 (pinned); Vite 8; Nitro node-server emitting `.output/server/index.mjs`. Backend Convex ^1.46 with components better-auth 0.12.2, resend, agent, rate-limiter, two workpools. Better Auth ~1.6.30: email+password with mandatory verification (min 12 chars), magic link with `disableSignUp`, optional Google, `accountLinking.enabled`, cookies `httpOnly; SameSite=Lax; Secure` only when `APP_ENV=production`, `trustedOrigins: [SITE_URL]`. AI: Mistral (`voxtral-mini-latest` transcription, `zai-glm-5-3` evaluation, `convex/lib/ai.ts`), Anthropic for the chat agent (`convex/agent.ts`). Web tier on Scalingo; `pnpm build` with `DEPLOY_CONVEX=true` deploys Convex in lockstep (`package.json:15`). Security headers set by Start middleware (`src/start.ts`, `src/lib/security-headers.ts`) on the web origin only; the Convex site origin (`/api/chat`, `/resend-webhook`, BA routes) gets none of them.

Offline limits: `node_modules` is absent and installation is prohibited, so vitest/convex-test suites, typecheck, lint and build cannot run. Dependency-free modules that load under `node --experimental-strip-types` (verified): `convex/lib/{safeUrl,tokens,clock,slug,weights,htmlText,evidence,paraverbal,sigv4,sessionState,candidateView,prompts}.ts`, `src/lib/{security-headers,candidate-list,changelog,media/devices}.ts`. Scripts `audit-convex-access.mjs`, `codegen-api-types.mjs --check`, `sync-skills.mjs --verify` are dependency-free and read-only. Sandbox controls verified: `env -i`, `unshare -mn` with read-only bind mounts and private tmpfs scratch, `prlimit`, `timeout`.

## 4. Entry surfaces and important paths

- **BA identity → Convex**: `authComponent.safeGetAuthUser` → `users` row by `betterAuthId`; `provisionAppUser` falls back to email and re-points an existing row (`convex/lib/auth.ts:48-105`); `user.update.after` hook keeps `users.email` in sync.
- **Candidate**: token → `requireSession`/`requireOpenSession` → gate (`convex/lib/sessionState.ts`) → presigned PUT for documents/segments with server-derived keys, attach re-checks prefix; `finish` schedules the paid pipeline.
- **Share**: token → `resolveShare` → report projection; `sharedMediaUrls` mints signed GETs with the server clock.
- **Recruiter**: org-scoped queries keyed by `orgId` argument then membership; project functions read the org off the row (`requireProjectAccess`).
- **Job import**: recruiter URL → `convex/lib/safeUrl.ts` lexical check → Node action `convex/jobImportFetch.ts` (DNS check per hop, manual redirects, 2 MiB cap, content-type allow-list) → `htmlText` → Mistral → Zod draft.
- **Chat**: `chat.sendMessage` (rate-limited) or `POST /api/chat` (bearer, no rate limit) → thread scoped `${orgId}:${userId}` → agent with three read-only tools that re-derive membership from the thread scope (`convex/lib/agentScope.ts`).
- **Pipeline**: `onSessionCompleted` → transcription per segment → fan-in → `generateReport` (Zod-validated, index-addressed, quotes re-anchored) → notify.
- **Erasure**: candidate `deleteMyData` and recruiter `deleteCandidateData` share `purge.*`; objects before rows; `purgeLog` stores a salted hash.
- **Email**: `convex/emailTemplates.ts` with `esc()` on HTML branches; subjects raw; Resend HTTP API.

## 5. Trust boundaries and strongest source-visible control

| Boundary | Control |
|---|---|
| Anonymous → BA account | BA verification/magic-link/`disableSignUp`, per-route BA rate limits, invite-token hook predicate `convex/lib/invitations.ts` |
| Token → candidate session | `looksLikeToken` + `by_token`, identical failure, projectors + `returns` validators, gate with `effectiveNow` |
| Token → share | `resolveShare`, `returns` validator, server clock in actions |
| Member → org data | `requireOrgMember(orgId)`; project functions via `requireProjectAccess` reading org off the row |
| Member → destructive project ops | `requireProjectOwnerOrAdmin` |
| Model → data | tools scoped by thread `userId`, read-only, `readMembership` + `canSeeProject` |
| Server → bucket | SigV4 presign signing key, content-type, content-length; keys derived server-side |
| Recruiter URL → server fetch | `assertPublicHttpUrl` + per-hop DNS check |
| Repo → CI | `permissions: contents: read`; `release-tag.yml` `contents: write` |

## 6. Starting paths

`convex/lib/auth.ts`, `convex/lib/projectAccess.ts`, `convex/candidate.ts`, `convex/interview.ts`, `convex/shares.ts`, `convex/projects.ts`, `convex/sessions.ts`, `convex/reports.ts`, `convex/media.ts`, `convex/files.ts`, `convex/organizations.ts`, `convex/invitations.ts`, `convex/users.ts`, `convex/admin.ts`, `convex/auth.ts`, `convex/http.ts`, `convex/chat.ts`, `convex/recruiterTools.ts`, `convex/jobImport*.ts`, `convex/pipeline.ts`, `convex/lib/ai.ts`, `convex/lib/objectStore.ts`, `convex/lib/sigv4.ts`, `convex/purge.ts`, `convex/retention.ts`, `convex/emailTemplates.ts`, `src/start.ts`, `src/lib/security-headers.ts`, `src/routes/**`, `src/components/ai*/**`, `scripts/*.mjs`, `.github/workflows/*.yml`.

## 7. Prior coverage

No compatible prior `coverage-ledger.json`/`findings.json` exists; every unit is seeded `prior_status: none`. A hand-written review (`docs/audit/2026-09-15/*`, `docs/audit/2026-09-16-chantiers.md`) exists in another format; several of its findings (client-controlled `now`, camera Permissions-Policy, purge index) have since been fixed per `CLAUDE.md`. It is reconnaissance input only, never coverage evidence and never an exclusion.

## 8. Companion selection

- **WEB-PROTOCOL-AND-AUTH.md** — BA sessions, recovery, account linking, invite-token pre-verification, cookies, auth proxy, response headers.
- **CLIENT-SIDE.md** — SPA rendering of model output (Streamdown), return-URL handling, i18n `escapeValue:false`, browser storage.
- **AI-AND-LLM.md** — chat agent tools/threads, job-import page content as model context, pipeline model output.
- **DATA-ISOLATION-AND-LIFECYCLE.md** — multi-tenant queries, search index, object keys and signed URLs, share links, erasure/retention.
- **RESOURCE-EXHAUSTION-AND-AVAILABILITY.md** — unbounded strings, missing limiter on `/api/chat`, uncapped event rows, paid model calls triggered by low-trust principals.
- **SUPPLY-CHAIN-AND-RELEASE.md** — CI workflows, Renovate automerge, `sync-skills`, `upgrade-template`, `.mcp.json`.
- **CLOUD-AND-DEPLOYMENT.md** (narrow) — `MEDIA_ORIGIN` spliced into CSP, event-source identity of the Resend webhook, secret precedence.
- **PROTOCOLS-RPC-AND-MESSAGING.md** (narrow) — webhook duplicate delivery/idempotency.
- Excluded: MEMORY-SAFETY-AND-BINARY.md (no native code, no custom parsers beyond regex HTML stripping), DESKTOP-MOBILE-AND-LOCAL-IPC.md (no native app, deep link, or webview bridge).
