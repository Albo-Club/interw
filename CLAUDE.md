# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

**Sober and elegant, not just short.** The rules above subtract; this one says
what to aim for. Minimal is the line count — simple is how much the next
reader has to hold in their head. Aim for both, and where they disagree pick
the version that is obvious on first read.

- Reach for the plainest construct that does the job: a function over a class,
  a plain object over a registry, an early return over a nested branch, the
  language over a dependency.
- Elegance is fewer moving parts, never a cleverer trick. Code that needs a
  comment to explain *how* it works should be rewritten — comments are for
  *why*.
- The most elegant change is often a deletion. Before adding a layer, check
  whether removing one solves the same problem.
- Write it the way this codebase already writes it. Consistency is part of
  simplicity: a locally-brilliant pattern nobody else uses costs more than the
  boring one everybody reads without thinking.

The `/simplify` pass in § 6 checks this after the fact. It is a safety net,
not a licence to write the sprawl first and clean up later.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Keep the Docs and Skills Fresh

**Tidy-room rule** : every doc line earns its keep, every fact lives in exactly
one file. Surface non-obvious knowledge ; drift kills future you.

### Pre-PR doc audit (run it yourself, every PR, without being prompted)

Before pushing the final commit, walk through these four questions. If none
fire, write nothing — the diff and commit message already document the *what*.
Docs are for the *why* and the *trap*.

1. **Touched a route, page, env var, or workflow listed in `TESTING.md`** ?
   → update the matching row in the same PR.
2. **Hit a non-obvious gotcha that'd cost the next dev > 30 min** (SSR trap,
   pinned version, bundler quirk, API edge case) ? → add a section to
   `KNOWN_ISSUES.md`. Include the *why* and the workaround pattern.
3. **Found a stale claim while reading existing docs** (file path that no
   longer exists, flag that was renamed, API that changed) ? → fix it in the
   same commit as the change that made it stale.
4. **Discovered a behavioral rule worth applying to every future PR** ? → add
   it here in `CLAUDE.md`. Only for *repeatable* guidance, never as a
   changelog of what shipped.

### Where things live (don't duplicate across files)

- `README.md` — how to use, quickstart, public-facing onboarding.
- `TESTING.md` — manual + automated validation steps, organized per route /
  feature. Update when adding or changing a verifiable surface.
- `KNOWN_ISSUES.md` — traps, pinned versions, SSR/bundler/browser gotchas,
  "we tried X, here's why we chose Y". One section per trap.
- `CLAUDE.md` — repeatable behavioral rules for future agents. Never a
  changelog of completed work.
- `AGENTS.md` — pointer to the agent-skill workflow. Static, rarely changes.
- `PORTING.md` — how a fix landed here reaches the projects forked from this
  template: what `upgrade-template` conflicts on, how to verify a derived
  project, and ready-to-paste prompts. Add a prompt here when you ship
  something downstream needs and `upgrade-template` won't carry cleanly.

If you're about to add the same info to two of these files, you're doing it
wrong — link, don't duplicate.

### Skills

`.agents/skills/` is pulled from upstream — never edit in place
(`pnpm run sync:skills` overwrites). When upstream is wrong or missing,
override here via `CLAUDE.md` / `KNOWN_ISSUES.md`. When
`pnpm run sync:skills:check` reports drift, read the new SKILL.md and
update project overrides if needed — don't mute the check.

**Two skill channels, don't mix them.** The `sync:skills` pipeline is only
for library skills that upstream does **not** ship as a Claude Code plugin.
Skills delivered by a plugin (e.g. `resend@claude-plugins-official`, enabled
in `.claude/settings.json`) auto-update via the marketplace — never
re-vendor them into `skills-lock.json` / `.agents/skills/` (it would
duplicate the skills and double the update machinery). See `KNOWN_ISSUES.md`
§ "Resend: two integrations".

## 6. Two review passes before every PR

**Mandatory, self-initiated, on every PR — no exception for "small" diffs.**
Once the change is complete and `pnpm typecheck` / `pnpm lint` / `pnpm test`
are green, and **before** the branch is pushed, in this order:

1. `/simplify`, on the uncommitted working tree — quality pass: reuse,
   simplification, efficiency, altitude. It applies its fixes, so re-run the
   checks above afterwards, then commit.
2. `/security-review`, **after** committing. It reads the branch's commits
   against `origin/HEAD`, so on an uncommitted tree it reviews an empty diff
   and reports nothing — indistinguishable from a clean pass. Anything it
   turns up goes in a follow-up commit, then push.

Then act on the findings: fix them, or state in the PR body why a finding is
not applicable. Never open the PR with an unaddressed finding left silent.

**Enforced by git, not by trust.** `.githooks/pre-push` refuses to push a
commit that has not been recorded as reviewed; once both passes are clean,
record it with `pnpm review:ok`. The gate lives in git rather than in a Claude
Code hook so that it holds for any agent and for a human at a terminal alike,
and the marker is bound to the commit sha — passes run before later commits do
not vouch for them. `git push --no-verify` bypasses it, which is there for a
revert or a typo fix; reaching for it on real work is the one move that makes
this whole section decorative.

The two passes are complementary, not interchangeable. `/simplify` does not
hunt for bugs or vulnerabilities; `/security-review` does not judge whether
200 lines could have been 50. Skipping one because the other came back clean
defeats the point.

If a skill is unavailable in the current session, say so explicitly in the PR
body rather than claiming the pass ran.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

---

# Project-specific guide

## Language

All code-related content must be written in English: source code comments,
skill files, `CLAUDE.md`, `TESTING.md`, `KNOWN_ISSUES.md`, inline
documentation, error messages visible to developers, log strings, and any
other developer-facing text. The only exceptions are user-facing copy in
`src/locales/fr/` and bilingual email templates in `convex/emailTemplates.ts`.

## End-to-end test plan

Before each production deployment, run through `TESTING.md`
(levels 1 → 6, ~70 min). Level 1 is automated (`pnpm typecheck`,
`pnpm lint`, `pnpm build`, `pnpm test:smoke`, `pnpm sync:skills:verify`,
`pnpm sync:skills:check`);
the rest is manual — a sign-off checklist to validate auth, multi-tenant,
invitations, roles and questions, the candidate interview, reports and their
share links, uploads, account lifecycle, super-admin, AI chat, security.

## Stack

- **Frontend** : React 19 + TypeScript strict, TanStack Start v1 (Node server target), TanStack Router (file-based, `src/routes/`), TanStack Query, TanStack Form + Zod, Vite.
- **Styling** : Tailwind CSS v4 (CSS-first, no `tailwind.config.js`), shadcn/ui (neutral theme, `src/components/ui/`), Inter, radius `0.5rem`, tokens in `src/styles/brand.css` (oklch).
- **Backend** : Convex (`^1.x`) — queries, mutations, actions, HTTP routes, file storage, components.
- **Auth** : Better Auth via `@convex-dev/better-auth` with `magicLink()` + `convex()`. Multi-tenant (orgs/members/invitations/roles) is implemented **natively in the Convex schema** (`organizations`, `organizationMembers`, `invitations` tables). The BA `organization()` plugin is deliberately **not loaded** — its tables aren't first-class Convex (no `withIndex` joins). See `KNOWN_ISSUES.md` for trade-offs.
- **Emails** : `@convex-dev/resend` for transactional.
- **AI** : `@convex-dev/agent` backend (default model `claude-haiku-4-5`, override via `ANTHROPIC_MODEL`) + `@assistant-ui/react` front + streaming HTTP route `/api/chat`. Provider abstracted via `getModel()` in `convex/agent.ts`. The chat agent's tools (`convex/recruiterTools.ts`) are scoped to the thread's org and **read-only**: `listRoles`, `listCandidates`, `readReport`. A hiring decision is never a tool call — see « AI and hiring » below.
- **File storage** : Convex native (`ctx.storage.generateUploadUrl()`), 20 MB cap.
- **Observability** : Sentry (front + Convex actions). CORS strict, security headers, HMAC verify on webhooks.

## Skills (READ BEFORE CODING)

**Required**: before writing or modifying any code touching one of the
domains below, read the corresponding skill in `.agents/skills/`
(symlinked at `.claude/skills/`). It supersedes your training knowledge,
which is stale for these libraries.

Manifest: `skills-lock.json` — each skill pins an immutable commit
(`pinnedRef`, reproducible) and watches a moving branch (`trackingRef`) to
notice when upstream advances; `computedHash` is the SHA-256 of the vendored
content. Both guarded in CI (`.github/workflows/ci.yml`): job `skills-verify`
re-hashes the working tree against the lock, job `skills-drift` compares the
lock against upstream.

Skills that split content out of `SKILL.md` declare their auxiliary files in an
optional `references` array, with paths relative to the `SKILL.md` directory —
identical upstream and locally, so the relative Markdown links keep resolving.
References are folded into `computedHash`, so drift detection covers them.
**Any new auxiliary file must be added there**: a file vendored by hand is seen
by none of `sync:skills`, `--check` or `--verify`, and rots silently.

A `references` path may only point at a **descendant** of the `SKILL.md`
directory — never `../`, which writes outside `.agents/skills/<name>/`. To root a
tree elsewhere upstream, add a second lock entry. Same section of
`KNOWN_ISSUES.md` explains why, and why `MAX_IN_FLIGHT` in the sync script must
stay put as the skill list grows.

An upstream that publishes its rules as a plain `AGENTS.md` rather than a real
skill declares an optional `frontmatter` map, prepended to `SKILL.md` at vendor
time (the Agent Skills spec makes `name` + `description` mandatory, and `name`
must equal the directory name). It is applied **before** hashing, so editing it
registers as drift exactly like an upstream change. Reach for it only when
upstream ships no `SKILL.md` — never to "fix" a description you disagree with,
which belongs in an override here. See `KNOWN_ISSUES.md` § "`web-design-guidelines`
vendors `AGENTS.md`".

**Two distinct questions, two modes — don't conflate them.** `--verify` answers
"is my working tree intact?" (local re-hash, offline, deterministic); `--check`
answers "has upstream moved?" (network, and the answer changes without anyone
touching the repo). `--check` alone is blind to a vendored file edited or left
stale on disk — it compares the upstream tip to the lock and never reads what
we actually shipped. See `KNOWN_ISSUES.md` § "`--check` is blind to the working
tree — hence `--verify`".

- `pnpm run sync:skills` — vendor each skill at its `pinnedRef`
  (reproducible, no network surprise; idempotent). **Self-healing**: rewrites
  any file that no longer matches `computedHash`, so it repairs a corrupted or
  stale tree without `--force`, and unlinks any `.claude/skills/` symlink whose
  lock entry is gone.
- `pnpm run sync:skills:verify` — re-hash the vendored files and compare to the
  lock, and report orphaned symlinks; exit 2 if the tree diverged. No network —
  this is the offline CI gate.
- `pnpm run sync:skills:check` — compare each `trackingRef` tip against the
  vendored content; exit 2 on drift (upstream moved since the last bump).
- `pnpm run sync:skills:update` — advance `pinnedRef` to the current
  `trackingRef` tip, re-vendor, rewrite the lock. The deliberate bump — do it
  after reviewing the diff.

Rule: `--verify` guards, `--check` detects, `--update` bumps. Never `--update`
without reading what the new version changes.

**When the CI job `skills-verify` is red**: the vendored tree no longer matches
the lock — someone hand-edited `.agents/skills/`, a file is missing, or a
`.claude/skills/` symlink outlived the lock entry that owned it.
`pnpm run sync:skills` repairs all three (no `--force` needed), then re-read the
`git diff`: if the content reverts to what the lock says, the local edit was
the mistake. Never patch `skills-lock.json` to match a hand edit.

**Removing a skill is two deletions, not one.** Drop the lock entry *and* run
`pnpm run sync:skills` so the symlink goes with it — committing the lock alone
leaves Claude Code advertising a skill whose `SKILL.md` no longer exists. See
`KNOWN_ISSUES.md` § "Third hole, same family: a pruned skill left its
symlink behind".

**When the CI job `skills-drift` is red** (upstream moved): never bypass it, and
never `--update` blindly. Run `pnpm run sync:skills:check` to name the drifting
skill(s), read what the new upstream version changes, then `--update` and review
the diff — a skill update is a prompt-injection surface, so read it rather than
rubber-stamp it. Check that no project override in `CLAUDE.md` /
`KNOWN_ISSUES.md` became false.

| Skill                                     | Domain                                 | Upstream source                            | Official?  |
| ----------------------------------------- | -------------------------------------- | ------------------------------------------ | ---------- |
| `convex-create-component`                 | Building a Convex component            | `get-convex/agent-skills`                  | ✅ official |
| `better-auth-best-practices`              | General Better Auth config             | `better-auth/skills`                       | ✅ official |
| `better-auth-security-best-practices`     | Hardening (rate-limit, CSRF, sessions) | `better-auth/skills`                       | ✅ official |
| `email-and-password-best-practices`       | Email/password BA                      | `better-auth/skills`                       | ✅ official |
| `two-factor-authentication-best-practices`| 2FA / TOTP / backup codes              | `better-auth/skills`                       | ✅ official |
| `organization-best-practices`             | BA `organization()` plugin             | `better-auth/skills`                       | ✅ official ⚠️ |
| `create-auth-skill`                       | Auth BA scaffolding                    | `better-auth/skills`                       | ✅ official |
| `tanstack-start-core`                     | **Start entry point** + server functions, middleware, server auth, execution model, server routes, deployment | `TanStack/router` (official monorepo) | ✅ official |
| `tanstack-react-start`                    | React bindings for Start + server components| `TanStack/router` (official monorepo) | ✅ official |
| `tanstack-router-core`                    | **Router entry point** + data loading, guards, SSR, 404/errors, search/path params, navigation, code splitting, type safety | `TanStack/router` (official monorepo) | ✅ official |
| `tanstack-react-router`                   | React hooks/components of the router   | `TanStack/router` (official monorepo)      | ✅ official |
| `tanstack-router-query`                   | Router ↔ TanStack Query integration    | `TanStack/router` (official monorepo)      | ✅ official |
| `agentmail`                               | Email inboxes for AI agents (AgentMail)| `agentmail-to/agentmail-skills`            | ✅ official |
| `frontend-design`                         | Aesthetic direction for new UI         | `anthropics/skills`                        | ✅ official |
| `web-design-guidelines`                   | Interface correctness rules (a11y, focus, forms, motion, perf) | `vercel-labs/web-interface-guidelines` | ✅ official |

**`agentmail`**: official AgentMail skill (email-for-AI-agents platform).
Vendored from `agentmail-to/agentmail-skills` at `agentmail/SKILL.md`. Needs
`AGENTMAIL_API_KEY` in the environment. `SKILL.md` is a router: the actual
patterns live in the six vendored `references/` files (TypeScript, Python,
admin/DNS, webhooks, websockets, deliverability) — read the one matching your
task rather than working from `SKILL.md` alone.

**The two design skills are a pair, not a choice.** `frontend-design`
(Anthropic) is *generative* — palette, typefaces, layout concept, the one
signature element, and how to avoid the templated look. `web-design-guidelines`
(Vercel) is *corrective* — MUST/SHOULD/NEVER rules for keyboard and focus
behaviour, hit targets, forms, motion, layout, performance, dark mode and
hydration. A new surface wants both: the first to decide what it looks like,
the second to check it before the PR. Neither knows this project's tokens —
colours and radii still come from `src/styles/brand.css`, never a hardcoded
`className` (see Anti-patterns). Much of the Vercel rule set is already
satisfied by `src/components/ui/` (shadcn builds on Radix); it earns its keep on
hand-rolled interactive markup, which is where the a11y gaps actually appear.

**⚠️ `organization-best-practices`**: official BA skill, but the
`organization()` plugin is **disabled** in this project (see `KNOWN_ISSUES.md`).
Read it to understand the concepts; don't apply the BA code as-is —
our orgs/members live in the custom Convex schema.

**TanStack (`TanStack/router`)**: official source, versioned with the
`@tanstack/react-start` / `@tanstack/react-router` releases in the monorepo
(`packages/*/skills/*/SKILL.md`). If a behavior change is unclear, fall back to
the `context7` MCP (`mcp__…__query-docs`) for `/tanstack/start`.

**Start with `tanstack-start-core` or `tanstack-router-core`.** Those two are
*routers*: each opens on a sub-skill table + decision tree, and the real content
lives in descendant directories reached from there
(`tanstack-start-core/server-functions/SKILL.md`,
`tanstack-router-core/data-loading/SKILL.md`, …). Sub-skills are vendored as
`references`, so their sibling links resolve locally — but Claude Code only
registers the 5 top-level skills, so a sub-skill is *read through its parent's
table*, never picked from the skill list.

Upstream links that climb out of a skill (`../../../<pkg>/skills/<skill>/…`)
**dangle by design**: we vendor flat (`.agents/skills/<name>/`), upstream nests
under `packages/<pkg>/skills/`. Translate with `<skill>[/<sub>]` →
`tanstack-<skill>[/<sub>]` (so `start-client-core/skills/start-core/middleware`
→ `tanstack-start-core/middleware`); the one irregular case is
`react-router/skills/compositions/router-query` → `tanstack-router-query`. See
`KNOWN_ISSUES.md` § "Vendored skills: cross-family links".

**shadcn/ui**: no agent skill yet. Conventions live in `components.json`
(alias `@/components`, neutral theme, radius 0.5rem, oklch tokens in
`src/styles/brand.css`). To generate/update a component, use the CLI
`pnpm dlx shadcn@latest add <component>` or the shadcn MCP if configured.
NEVER modify `src/components/ui/*` by hand to restyle — go through CSS tokens.

**Better Auth UI** (`better-auth-ui.com`, `daveyplate/better-auth-ui`,
shadcn registry, v1.6.x, active): unofficial drop-in kit for Better Auth that
ships `<SignIn>`, `<SignUp>`, `<ForgotPassword>`, `<ResetPassword>`,
`<SignOut>`, `<Settings>`, `<AccountSettings>`, `<ChangeEmail>`,
`<ChangePassword>`, `<SecuritySettings>`, `<ActiveSessions>`,
`<LinkedAccounts>`, `<UserButton>`, `<UserAvatar>`, plus React hooks
(`useSession`, `useListSessions`, `useChangePassword`, …) and email templates
(`<EmailVerificationEmail>`, `<MagicLinkEmail>`, `<PasswordChangedEmail>`,
`<NewDeviceEmail>`, …). Install via `pnpm dlx shadcn@latest add
https://better-auth-ui.com/r/auth.json`. Full inventory:
`better-auth-ui.com/llms.txt`.

**When to consult**: new projects or new auth surfaces (passkey, multi-session,
OAuth providers, OTP, active sessions, captcha). Do **not** retroactively
migrate `/login`, `/register`, `/forgot-password`, `/reset-password`: we
already have custom code on top (anti-enum, error classifier, HIBP, zxcvbn
meter, FieldDescription, inline alert) that the kit doesn't cover. For
**gaps** identified vs Better Auth UI (active sessions, post-event
notifications, linked accounts), evaluate case by case whether to adopt the
drop-in components or roll our own to stay consistent with the rest of the
project.

**Convex knowledge comes from three self-refreshing channels, not from
vendored skills.** Only `convex-create-component` is still vendored — the rest
were pruned (see `KNOWN_ISSUES.md` § "Convex skills were pruned"). In order of
precedence:

1. `convex/_generated/ai/guidelines.md` — regenerated by `convex dev`.
   Required reading before non-trivial Convex patterns; **it overrides
   everything, including upstream skills.**
2. The **Convex MCP server** (`.mcp.json`, `npx convex mcp start`) — reads the
   live deployment: tables, data, logs, insights, env. Prefer it over any
   static doc for "why is this slow / what's actually in the DB / what broke"
   — it cannot go stale, because it reads the real app.
3. This file + `KNOWN_ISSUES.md` for the decisions Convex's own docs cannot
   know (Better Auth over Convex Auth, hand-rolled multi-tenant, and so on).

Do not re-vendor Convex skills to "fill a gap" without reading that
`KNOWN_ISSUES.md` section first — the gap is usually covered by 1 or 2.

## Routing conventions

- Imports from `@tanstack/react-router`, never `react-router-dom`.
- No trailing slash in paths.
- Every route with a loader must define `errorComponent` AND `notFoundComponent`.
- Shareable routes must have their own `head()` with title, description, og:\*.
- Anchors `#section` only for intra-page (TOC, long FAQ).
- Naming convention: flat with dots (`posts.$postId.tsx`).

## Server functions vs Convex

- **Live data (read/write DB)** → `useQuery(api.foo.bar)` / `useMutation(api.foo.create)` client-side (Convex real-time auto).
- **Server business logic + LLM calls** → Convex `action` with `"use node"` if Node-only deps.
- **Transactional email** → Convex `action` + `@convex-dev/resend`.
- **Incoming webhook** → Convex HTTP route in `convex/http.ts`.
- **Auth proxy** → `createServerFn` or TanStack route `server.handlers`.
- **Read a secret + complex logic** → `createServerFn`.

## Multi-tenant recipes

### Query data scoped to an org

```ts
// convex/projects.ts
export const list = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgMember(ctx, orgId)
    return ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
  },
})
```

### Mutation with role check

```ts
// convex/questions.ts — the guard reads the org off the ROW, never off an
// argument: an `orgId` the caller passes proves nothing about the row.
export const remove = mutation({
  args: { questionId: v.id('questions') },
  handler: async (ctx, { questionId }) => {
    const question = await ctx.db.get('questions', questionId)
    if (!question) throw new ConvexError('not_found')
    await requireOrgRole(ctx, question.orgId, 'admin')
    await ctx.db.delete('questions', questionId)
  },
})
```

### Protect a route by org membership

`/app/$orgSlug/route.tsx` :

- Auth guard (redirect `/login` if no session).
- Resolve `orgSlug` → `orgId` via Convex.
- Check membership; otherwise redirect `/app`.
- Store `orgId` in child router context.

## Anti-patterns

- ❌ `process.env.X` at top-level of a file imported client-side.
- ❌ `VITE_` prefix on a secret.
- ❌ DB / secret key directly in a `loader` (loaders are isomorphic).
- ❌ `react-router-dom` instead of `@tanstack/react-router`.
- ❌ Hard-coded color in `className`.
- ❌ User role stored on BA user table (use `users.superAdmin` or `organizationMembers.role`).
- ❌ Role check via `localStorage`.
- ❌ `await prefetchQuery(...)` (blocks navigation).
- ❌ `QueryClient` as module-level singleton.
- ❌ `ConvexReactClient` recreated each render.
- ❌ Loading BA plugin `admin()` (breaks signup validator).
- ❌ Inline BA triggers (TS inference cycle with `internal.users.*`).
- ❌ Enabling a new BA auth method without checking **both** conditions:
  (1) the method produces a verified email on first use (magic link,
  OAuth, or email/password with `requireEmailVerification: true`), and
  (2) `account.accountLinking.enabled: true` is set in `createAuth`.
  Skipping either creates duplicate BA users — and therefore duplicate
  Convex `users` rows — for the same email. See `KNOWN_ISSUES.md`
  "Account linking & verified email".
- ❌ Dedup users by `betterAuthId` only in any new code path. Always
  also fall back to email via `withIndex('by_email', ...)` — pattern in
  `convex/lib/auth.ts:provisionAppUser`.
- ❌ A frequently-written field on the `users` row. Every query reads the
  caller's row via `requireAppUser`, so each write re-runs ALL open
  subscriptions. Per-user mutable state goes to `userPrefs`
  (`convex/lib/userPrefs.ts`). Same family: a mutation fired from a
  `useEffect` that depends on a Convex query observing the written data
  (cross-tab infinite loop). See `KNOWN_ISSUES.md` "Hot `users` row".
- ❌ Surfacing Better Auth errors via `error.message` (or worse, a regex
  on it) in any new client code. Always classify through
  `classifyAuthError()` + `formatAuthError(code, ctx)` from
  `src/lib/auth-errors.ts`. Reason: BA codes are granular (USER_NOT_FOUND
  vs INVALID_PASSWORD vs INVALID_EMAIL_OR_PASSWORD) and surfacing them raw
  leaks enumeration. Raw `error.message` is also locale-fragile and may
  change between BA versions. The classifier collapses safe equivalence
  classes and centralises the user-facing copy.
- ❌ Anchor `#section` for nav between major sections.
- ❌ Unrequested dark/light toggle.
- ❌ `tailwind.config.js` (Tailwind v4 is CSS-first).
- ❌ Editing `routeTree.gen.ts` or `convex/_generated/*` manually.
- ❌ Hardcoding a user-facing string anywhere (UI **or** transactional
  email). All user-facing copy goes through i18n: `t()` from react-i18next
  with namespaced keys in `src/locales/{en,fr}/<ns>.json`, or the bilingual
  templates in `convex/emailTemplates.ts`. **Dev-facing** strings stay in
  English and are never translated: internal error codes
  (`ConvexError('not_found')`, `AuthErrorCode` values), logs, comments,
  i18n key names. New strings need both an `en` and a `fr` entry. See
  `KNOWN_ISSUES.md` "i18n (react-i18next) SSR" for the no-flash rules.
- ❌ Module-level Zod schema carrying a hardcoded user-facing message. Build
  the schema inside the component via `useMemo(() => z.object({...}), [t])`
  so messages resolve from the `validation` namespace.
- ❌ A hardcoded page `<title>` in a route `head()`. `head()` runs outside
  React — resolve titles with
  `getI18n(getLocale()).getFixedT(null, '<ns>')('key')`.
- ❌ Surfacing an auth error via raw copy. Classify with `classifyAuthError`,
  then `formatAuthError(code, ctx, t)` where `t` resolves the `errors`
  namespace (pass `(k) => t(\`errors:${k}\`)`).
- ❌ A return-URL search param typed as bare `z.string()`, or validated with a
  hand-rolled regex. Any value that reaches `window.location.*`, `<a href>` or
  a `router.navigate` must go through `internalRedirectSearch` from
  `~/lib/safe-redirect`, which resolves it with the URL parser. A regex like
  `/^\/(?![/\\])/` looks right and is bypassable: browsers strip ASCII
  tab/newline, so `/\t/evil.com` becomes `//evil.com` after the check passes.
  Better Auth's `trustedOrigins` only covers params *it* receives
  (`callbackURL`, `errorCallbackURL`, `redirectTo`) — never a redirect we
  navigate to ourselves. See `KNOWN_ISSUES.md` § "A return-URL search param
  needs the URL parser".
- ❌ Touching the pnpm version pin. `packageManager` in `package.json` is the
  single source of truth, read by Corepack, by `pnpm/action-setup@v4` (which
  is why CI passes **no** `version:`) and by Scalingo's Node buildpack, which
  selects pnpm from the lockfile. Never re-pin a version in `ci.yml`, never hand-edit the sha512
  hash (use `corepack use pnpm@<version>`), and never bump to a major the
  deployment target doesn't resolve. Same family: don't move `pnpm.overrides`
  out of `package.json` — `pnpm-workspace.yaml` settings are invisible to
  pnpm 9, which a host resolving `lockfileVersion: 9.0` may still pick. See `KNOWN_ISSUES.md` § "pnpm 11 silently drops
  `pnpm.overrides`".
- ❌ Keeping an inherited header, CSP directive or config flag that **denies a
  capability the product has since gained**. `Permissions-Policy: camera=()`
  is an empty allowlist — it denies the document itself — and a CSP with no
  `media-src` blocks every `<video>` from the bucket. Both shipped a whole
  build because the only automated check *asserted the emitted value*. When a
  change introduces a capability (camera, microphone, media playback, a new
  origin), re-read `src/lib/security-headers.ts` in the same PR, and write the
  assertion against what the capability needs — never against what the code
  currently returns. See `KNOWN_ISSUES.md` § "The template's HTTP headers
  denied the camera".
- ❌ Sizing `node_modules` with `du`, or "optimising" disk with
  `node-linker=hoisted` / `package-import-method=copy` / a hand-rolled shared
  `node_modules`. pnpm already clones from the store via APFS copy-on-write:
  `du` over-reports by ~24×, and each of those settings would convert free
  clones into real bytes. See `KNOWN_ISSUES.md` § "`node_modules` is not as
  big as `du` says".

## Security

- Application roles in `users.superAdmin` and `organizationMembers.role`, NEVER in the BA user table.
- Auth checks always server-side via helpers (`requireAppUser`, `requireOrgMember`, `requireOrgRole`, `requireSuperAdmin`).
- Secrets via `pnpm exec convex env set X <value>` or `.env.local` (never committed).
- No `VITE_` prefix on secrets.
- HMAC verify on every incoming webhook (`crypto.timingSafeEqual`).
- Better Auth CORS reduced to origins allowed in `BETTER_AUTH_URL`.

## Dev workflow

- `pnpm add <pkg>` BEFORE writing the import (otherwise Vite hard-fails).
- Create the target file BEFORE writing a local import.
- `pnpm dev` runs Vite + `convex dev` in parallel (via `concurrently`).
- Before commit: `pnpm typecheck` must pass + Convex log must show `ready`.
- Shipped something users can see? Add an in-app changelog entry: metadata
  in `src/lib/changelog.ts`, copy (en + fr) in
  `src/locales/{en,fr}/changelog.json`. The gate is user-visible, not
  per-PR — skills, CI, tooling and docs PRs get no entry. Security fixes are
  the one thing worth an entry despite being invisible in normal use; word it
  as the reassurance ("we hardened X"), never as a map of the vectors, since
  projects forked from here may still be unpatched.

---

# Interw domain rules

Rules that apply to every change in this product, not a record of what was
built. The *why* behind each one is in `KNOWN_ISSUES.md`; the manual
verification is in `TESTING.md`.

## Commands that must pass before a commit

- `pnpm codegen:api` after adding, renaming or removing a Convex module.
  `pnpm codegen:api:check` runs in CI and fails on stale codegen.
- `pnpm audit:access:check` — fails on any **public** Convex function with no
  access check. Also in CI.
- `pnpm test` — unit and `convex-test` integration suites.

## Access control

- Every new **public** Convex function calls a `require*` guard, or resolves a
  candidate/share token, as its first act. If a function is genuinely meant to
  be open, say so in a `// access: <reason>` comment directly above the export
  — the audit reads it and prints it, so exceptions stay few and visible.
- Never return a database row to a candidate or to a share link. Build the
  response with the explicit projectors in `convex/lib/candidateView.ts`, and
  add the field there deliberately. The point is that a new column on
  `sessions` cannot leak by default.
- A candidate-facing function resolves its token through `by_token` before
  anything else, and every token that fails to resolve fails **identically**.
  Expiry is a state of a resolved session, not a resolution failure.
- A caller never names the object key it wants to write. Derive it server-side
  from the row it belongs to, and re-derive it on attach rather than trusting
  the key you are handed.
- **An authorisation never depends on an argument, `now` included.** A query
  may take the caller's clock to stay reactive — that is what makes a link
  visibly stop working the moment it expires, without polling — but it passes
  it through `effectiveNow` from `convex/lib/clock.ts` before comparing it to
  anything. An action has the server's clock and nothing reactive to preserve,
  so it calls `Date.now()` and ignores whatever `now` it was handed. `now: 0`
  used to resurrect an expired share link and mint an hour of signed URLs on
  the candidate's video.

## Model output

- Every structured model output is validated with Zod before it reaches a
  caller, in `convex/lib/ai.ts`. **No repair pass, no silent defaults.** An
  evaluation that does not validate is not an evaluation; the job fails and
  the pool retries it.
- Models address criteria and answers by **index**, never by id. An index
  outside the range fails validation; an invented id has to be defended
  against.
- A skipped or duplicated criterion fails the whole report rather than
  shifting the weighted average unnoticed. A report that is quietly wrong is
  worse than one that retried.
- Every claim in a report carries a quote, and every quote is re-anchored
  against the transcript (`convex/lib/evidence.ts`). The model's own timestamp
  is a fallback; an unmatched quote returns null rather than a guess.
- Prompts live in `convex/lib/prompts.ts`, in English, parameterised by the
  interview language. Model ids live in `convex/lib/ai.ts` and nowhere else.

## The candidate surface

- `src/routes/s/**` and `src/components/candidate/**` may import
  `~/components/ui/*` and `~/lib/*`, and nothing else from the recruiter app.
  ESLint enforces it; the previous build shipped 2.96 MB of JS to candidates
  because everything sat in one import graph.
- Every technical state has a visible rendering: recording, sending, retrying,
  failed. A candidate gets one attempt — a failure they cannot see is an
  interview lost days before anyone finds out.
- `/s/**` and `/r/**` carry `noindex, nofollow`. These URLs are personal to
  one person.

## Pipeline

- Every job checks at entry whether its result already exists, so a retry is a
  no-op. Every transition is written to `jobLog` with its duration and
  outcome.
- **Never add a catch-up or repair script.** If a step can fail, the queue
  retries it. The previous build had three of them, which mostly documented
  that the normal path lost sessions.
- A `catch` either logs a named event or rethrows. For the narrow set of calls
  whose failure genuinely must not interrupt the user — a telemetry write, an
  autoplay attempt — use `fireAndForget` from `~/lib/fire-and-forget`, which
  makes the failure non-blocking rather than invisible.

## Erasure

- Objects are deleted **before** rows, always. A failure then leaves the row
  intact and the next pass retries; the reverse order orphans media in a
  bucket with nothing pointing at it.
- A segment row is written **before** its upload, carrying the keys. That is
  what makes erasure exact — even an answer whose upload failed is named in
  the database.
- Candidate self-erasure and recruiter deletion run the same code path, so
  they cannot drift into deleting different things.
- `purgeLog` stores a hash of the candidate's address, never the address.

## AI and hiring

- The AI disclaimer on a report is permanent and not dismissible. This is a
  hiring decision; saying the score is machine-produced and the call is the
  recruiter's is an obligation before it is a courtesy.
- Assistant tools over recruiting data are **read-only**. A decision, an
  invitation or a role change must never be reachable as a tool call — the
  person accountable has to be the one who made it.
- Every prompt touching a candidate carries the anti-discrimination clause
  from `convex/lib/prompts.ts`. Never remove it to "shorten the prompt".
