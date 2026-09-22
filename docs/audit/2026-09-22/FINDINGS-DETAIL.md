# Findings detail — confirmed medium and above (and low, for completeness)

Each entry copies the complete source path and the target-neutral, bounded local reproduction from findings.json. No deployment was contacted; every observed result comes from the unmodified repository modules executed in the parent sandbox.

## MEDIUM — POST /api/chat skips the per-user chatSend rate limiter that every other chat-generation path enforces, giving any org member unmetered paid model calls and unbounded agent-thread creation

Fingerprint: `convex/chat.ts:streamOverHttp:chatSend-limiter-bypass`

The Convex site origin registers POST /api/chat unconditionally (convex/http.ts:28-32), handled by chat.streamOverHttp (convex/chat.ts:274-311). Both in-app generation paths charge the caller's per-user token bucket 'chatSend' before doing any paid work: sendMessage at convex/chat.ts:168 and respondToToolApproval at convex/chat.ts:213, both via consumeLimit (convex/rateLimiters.ts:70-83) against the bucket declared at convex/rateLimiters.ts:31-32 with the comment 'Chat messages: per user. AI calls are expensive.'. streamOverHttp resolves the bearer identity (chat.ts:275), validates org membership through internal.chat.actionAuthProbe -> requireOrgMember (chat.ts:287-289, convex/lib/auth.ts:107-120), then goes straight to chatAgent.streamText (chat.ts:300-304). It never calls consumeLimit, creates a brand-new durable agent thread on every request that omits threadId (chat.ts:292-294), and imposes no cap on body.prompt (chat.ts:303). A verified account that is a member of any organisation -- including one it created itself through the unmetered organizations.create (convex/organizations.ts:74-105) -- can therefore drive as many Anthropic generations as it likes, each worth up to ten model steps (convex/agent.ts:23), and persist one new thread per request, entirely outside the budget the operator set for exactly this action. The route is dead code as far as the product is concerned: no file under src/ references it.

**Root cause.** streamOverHttp (convex/chat.ts:274-311) was added as a second door onto the same paid action as sendMessage but reproduces only the authentication and authorization half of that handler. It omits the consumeLimit(ctx, 'chatSend', user._id) call that sendMessage (chat.ts:168) and respondToToolApproval (chat.ts:213) perform, and it creates a thread per request with no cap, so the chatSend bucket is enforced on the mutation paths only and not on the HTTP entry that reaches the same agent.

**Intended behaviour.** Every chat generation, whichever entry point triggers it, is charged to the caller's per-user chatSend bucket ('Chat messages: per user. AI calls are expensive.', convex/rateLimiters.ts:31), so a single user cannot exceed 30 generations per minute (burst 10) nor accumulate unbounded agent threads and messages.

### Trace

1. **entrypoint** `convex/http.ts:31` — http.route({ path: '/api/chat', method: 'POST' }): Public POST route on the Convex site origin, registered unconditionally, whose handler is chat.streamOverHttp. No client code under src/ calls it; it is reachable purely because it is registered.
2. **propagation** `convex/chat.ts:275` — streamOverHttp: authComponent.safeGetAuthUser(ctx) resolves the identity a Convex httpAction takes from the Authorization bearer JWT; a caller with no identity is answered 401 at line 276 and reaches nothing.
3. **propagation** `convex/chat.ts:287` — streamOverHttp: ctx.runQuery(internal.chat.actionAuthProbe, { orgId }) runs requireOrgMember on the body-supplied orgId (convex/lib/auth.ts:107-120); a non-member throws ConvexError('not_a_member'). This is the last check performed before the paid call when the body carries no threadId, and no consumeLimit follows it anywhere in the handler.
4. **propagation** `convex/chat.ts:294` — streamOverHttp: createThread(ctx, components.agent, { userId: scope }) runs on every request whose body omits threadId, creating one new durable agent thread per call with no cap, quota or cleanup.
5. **sink** `convex/chat.ts:300` — streamOverHttp: chatAgent.streamText issues the paid Anthropic generation (up to stepCountIs(10) steps with the read-only recruiter tools, convex/agent.ts:23) on a prompt of unbounded length (line 303), having never consulted the chatSend bucket.

### Evidence

- `convex/chat.ts:168` — sendMessage: `await consumeLimit(ctx, 'chatSend', user._id)` immediately after requireOrgMember and before saving the prompt or scheduling streamAsync -- the intended per-user budget on this exact action.
- `convex/chat.ts:213` — respondToToolApproval also consumes chatSend before resuming generation. streamOverHttp (274-311) is the only generation path in the file that contains no consumeLimit call.
- `convex/rateLimiters.ts:32` — `chatSend: { kind: 'token bucket', rate: 30, period: MINUTE, capacity: 10 }` keyed per user -- the operator's declared bound, annotated at line 31 as 'Chat messages: per user. AI calls are expensive.'
- `convex/chat.ts:303` — `{ prompt: body.prompt }` -- the raw JSON body field is forwarded to streamText with no length validation; body is a bare cast (chat.ts:278-282), not a validator.
- `convex/agent.ts:23` — `stopWhen: stepCountIs(10)` -- a single streamText call is worth up to ten model steps plus the tool queries they make, so each unmetered request is a multiple of one generation.
- `convex/organizations.ts:74` — organizations.create requires only requireAppUser and inserts an organizationMembers row with role 'owner' for the caller, so any registered user can satisfy the membership precondition with an org of their own; the mutation itself consumes no limiter.
- `convex/http.ts:28` — The /api/chat route is registered with no access comment and no wrapper, unlike /resend-webhook at lines 18-26 which carries an explicit `// access:` justification.

### Principal and resource

An authenticated member of any organisation, including one it created for itself moments earlier, sends repeated JSON POSTs to https://<deployment>.convex.site/api/chat carrying the Convex bearer token the SPA already holds. Each request yields a new durable agent thread and a full agent generation, and none of them is counted against the chatSend bucket that caps the same action in the product UI.

### Conditions and containment

- **authentication_level**: Caller holds a valid Convex bearer JWT for a Better Auth account. Signup is self-service: email+password with requireEmailVerification (convex/auth.ts:103-105), plus invitation and optional Google.
- **authorization_role**: Caller is a member of any role of the organisation named in the request body. Any registered user can satisfy this by creating their own organisation, which makes them its owner (convex/organizations.ts:74-105).
- **system_configuration**: ANTHROPIC_API_KEY is configured on the Convex deployment so chatAgent.streamText reaches the provider; the route is registered unconditionally in convex/http.ts, with no feature flag.
- **third_party_dependency**: The only remaining bounds are outside the repository: Convex per-deployment HTTP-action concurrency and body limits, and the Anthropic account's rate and spend limits. These throttle the deployment as a whole rather than the abusing user, so when they bite they degrade chat for every tenant.

### Native input and bounded instructions

Inputs:

- `POST /api/chat  Authorization: Bearer <convex-jwt>  Content-Type: application/json  {"orgId":"<an org the caller belongs to>","prompt":"prompt 0"}`
- `the same request repeated N times with no threadId field (verifier harness used N=5) -- each one creates a thread and a paid model call`
- `{"orgId":"<own org id>","prompt":"<307200-byte string>"} -- accepted, forwarded to the model with no app-level prompt cap`

Instructions:

1. Bounded local check only; no deployment, network or external service was contacted (the sandbox has no network interfaces).
2. The verifier wrote its own loader hook and stubs rather than reusing the hunter's, in /root/security-audit-skill/interw/run-1/agents/verifier-v04/scratch/h/ : hooks.mjs maps the absent packages convex/values, convex/server, @convex-dev/agent and @convex-dev/rate-limiter, and the identity/paid/mail modules ./agent, ./auth, ../email, ../emailTemplates, to in-memory recorders; convex/chat.ts, convex/rateLimiters.ts, convex/lib/auth.ts, convex/lib/instructions.ts and convex/_generated/{api,server}.js load unmodified from the read-only repo.
3. Run: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v04 'cd h && node --experimental-strip-types --import ./register.mjs ./verify-chat.mjs'. Full output retained at scratch-relative chat-verify.log (promote if needed as evidence for the observed result below).
4. Fixture: users_A owner of org_A, users_B owner of org_B; identity switched through the ./auth stub; ctx.runQuery dispatches internal.chat.actionAuthProbe to the real handler after a v.id('organizations')-style argument check.
5. Case 2 (the claim): identity users_A, five invocations of chat.streamOverHttp with {orgId:'org_A', prompt:'p<i>'} and no threadId; record limiter calls, createThread calls and paid model calls.
6. Cases 3 and 3b (positive controls): invoke chat.sendMessage.handler and chat.respondToToolApproval.handler as the same user on one of those threads and record limiter calls.
7. Cases 1, 4, 5, 6, 7, 8 (bounding the claim): anonymous, non-member org, foreign-scope threadId, 300 KiB prompt, malformed JSON, missing prompt -- to establish that authentication, membership and thread scoping are intact and that only the limiter and the prompt cap are missing.

### Observed output and invariant proved

Case 1 anonymous: 401, 0 threads, 0 model calls. Case 2: five 200 responses with X-Thread-Id thread_1..thread_5; limiterCalls 0, threadsCreated 5, paidModelCalls 5, each agent call logged as createThread + PAID_MODEL_CALL under scope 'org_A:users_A'. Case 3 control: sendMessage on thread_1 recorded limiterCalls [{name:'chatSend', key:'users_A'}] and scheduled chat:streamAsync. Case 3b control: respondToToolApproval recorded the same chatSend consumption. Case 4 non-member: ConvexError not_a_member with 0 threads and 0 model calls. Case 5 foreign-scope threadId: ConvexError forbidden with 0 model calls. Case 6: 200 with the model call receiving promptBytes 307200 and 0 limiter calls. Case 7 malformed JSON: SyntaxError thrown after authentication, nothing reached. Case 8 missing prompt: 400, nothing reached. Total limiter calls recorded across every streamOverHttp invocation in the run: 0. This independently reproduces the hunter's result: membership and thread-scope enforcement hold, the per-user budget does not.

### Remediation and regression

Preferred: delete the route -- nothing under src/ calls it, and the in-app path (sendMessage + listMessages) already covers the product. If it must stay, make it pay the same budget as the mutation paths rather than trusting a second door: turn actionAuthProbe into an internalMutation that performs requireOrgMember and consumeLimit('chatSend', user._id) as one unit and is called with ctx.runMutation, so the limiter is structurally inseparable from the membership check instead of being a call someone can forget again; additionally validate the body (it is currently a bare cast, chat.ts:278-282), cap prompt length, and require an existing threadId rather than minting a durable thread per request. Regression test: load convex/chat.ts with @convex-dev/rate-limiter and @convex-dev/agent mocked and assert that streamOverHttp records a limit('chatSend', <userId>) call before any streamText call, mirroring the assertion for sendMessage -- the harness in this verification is a working template for it. Note for the reviewer: fixing this does not remove the need for a bound on organizations.create, which is itself unmetered and is what makes the membership precondition free to satisfy.

`convex/chat.ts`:

```ts
// Membership and budget as one unit: a second entry point cannot take the
// authorization half and leave the meter behind (this is exactly what
// streamOverHttp did). internalMutation, because consumeLimit writes.
export const actionAuthProbe = internalMutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    const { user } = await requireOrgMember(ctx, orgId)
    await consumeLimit(ctx, 'chatSend', user._id)
    return user
  },
})

// Keep an HTTP prompt bounded, like every other untrusted string.
const HTTP_PROMPT_MAX = 8_000

// ... inside streamOverHttp, replacing lines 287-304:
  if (!body.threadId) {
    // No thread-per-request: a durable thread is created through the
    // in-app path, which is metered and visible to the user.
    return new Response('Bad request', { status: 400 })
  }
  if (body.prompt.length > HTTP_PROMPT_MAX) {
    return new Response('Prompt too long', { status: 413 })
  }
  const probeUser = await ctx.runMutation(internal.chat.actionAuthProbe, {
    orgId: body.orgId as Id<'organizations'>,
  })
  const scope = scopeKey(body.orgId as Id<'organizations'>, probeUser._id)
  const threadId = body.threadId
  await authorizeThread(ctx, threadId, scope)

  const result = await chatAgent.streamText(
    ctx,
    { threadId },
    { prompt: body.prompt },
  )
```

## MEDIUM — emailEvents.recent (and sessions.countsForOrg) are scoped by organisation only, handing every member the candidate addresses and session ids of restricted roles they are hidden from

Fingerprint: `convex/emailEvents.ts:recent:org-scope-without-project-visibility`

Restricted projects are hidden from members not named on them: projects.list, getBySlug, sessions.listByProject, reports.forSession, reports.searchCandidates and dashboard.overview all apply canSeeProject or filterVisibleProjects and resolve to not_found, because 'a recruiter should not learn that a confidential role exists' (convex/lib/projectAccess.ts:7-10). The deliverability query emailEvents.recent is scoped only by organisation: it applies requireOrgMember and then returns, for up to 200 emailLog rows of the org, the recipient address, the template, the delivery status and the sessionId. sessions.sendInvitation writes exactly that — the candidate's address and their session id — for every invitation, including invitations to restricted projects. A plain member excluded from a confidential search can therefore read the addresses of every candidate invited to it, when they were invited and whether the mail bounced, plus the session ids. sessions.countsForOrg carries the same org-only scoping and lets the same member count the hidden sessions by differencing against dashboard.overview, which does filter. Both are public Convex queries reachable by any authenticated member; neither has a caller anywhere under src/, so no UI path is needed and none exists to notice the difference.

**Root cause.** emailLog rows carry orgId and sessionId but no project reference (convex/schema.ts:553-575), and emailEvents.recent (convex/emailEvents.ts:59-78) applies only requireOrgMember at line 62 before reading by_org_and_created at line 65 and returning recipient (line 71) and sessionId (line 74); sessions.countsForOrg (convex/sessions.ts:295-311) is scoped the same way at lines 298-303. The primary reads over the same underlying data (convex/dashboard.ts:30-44, convex/reports.ts:290-302) do apply the project-visibility predicate, so the derived reads disagree with the policy they are derived from.

**Intended behaviour.** Every read that names, counts or dates a candidate of a restricted project should pass through the same visibility predicate as the primary reads. convex/reports.ts:288-289 states it for search ('otherwise a confidential role leaks through the search box'), convex/notifications.ts:79-80 states it for notification audiences ('who sees the role is who hears about it'), and convex/lib/projectAccess.ts:9-10 states the stronger form: an invisible project must resolve to not_found rather than be discoverable at all.

### Trace

1. **entrypoint** `convex/emailEvents.ts:59` — emailEvents.recent (public query): A plain org member, excluded from a restricted project, calls the public query with their own orgId.
2. **propagation** `convex/emailEvents.ts:62` — emailEvents.recent handler: Only requireOrgMember(ctx, orgId) is applied; the returned member.role and the caller's projectShares are discarded.
3. **propagation** `convex/sessions.ts:221` — sessions.sendInvitation: Provenance of the rows being read: every invitation inserts an emailLog row with recipient = session.candidateEmail (line 224) and sessionId = session._id (line 227), whether or not the session's project is restricted.
4. **propagation** `convex/emailEvents.ts:65` — emailEvents.recent handler: The whole organisation's emailLog is read through by_org_and_created, newest first, up to 200 rows, with no per-row filtering.
5. **sink** `convex/emailEvents.ts:71` — emailEvents.recent return value: recipient — the candidate's email address — is returned to the excluded member, alongside template, status, createdAt and, at line 74, the sessionId of the hidden session.

### Evidence

- `convex/lib/projectAccess.ts:9` — Stated policy: an invisible project resolves to not_found, not 'forbidden', because 'a recruiter should not learn that a confidential role exists'.
- `convex/schema.ts:553` — emailLog is defined with orgId, template, recipient, status, providerId, error, sessionId and createdAt — no projectId, so no index on this table can express project visibility.
- `convex/sessions.ts:224` — The invitation emailLog row is written with recipient = the candidate's address (and sessionId at line 227).
- `convex/emailEvents.ts:74` — The sessionId of the hidden session is returned alongside the recipient.
- `convex/sessions.ts:301` — countsForOrg takes 500 sessions by the by_org index with no visibility filter, so its counts include sessions of projects the caller cannot see.
- `convex/dashboard.ts:44` — dashboard.overview filters its sessions to visibleProjectIds built by filterVisibleProjects (line 30): the primary read applies the policy the derived reads omit, and the difference between the two counts is the hidden-session count.
- `convex/reports.ts:290` — searchCandidates re-applies the restricted/projectShares check at retrieval time with the comment that otherwise 'a confidential role leaks through the search box' — the pattern emailEvents.recent lacks.
- `convex/notifications.ts:79` — sendReportReady narrows its audience to the creator plus the named shares for a restricted project, confirming the intended policy for anything derived from a restricted role.
- `docs/audit/2026-09-15-audit-complet.md:142` — The prior hand-written review already lists emailEvents.recent as dead code with no interface; the public Convex function nonetheless remains deployed and callable.

### Principal and resource

A recruiter deliberately left off a confidential search opens the app, takes the orgId already present in their client state, and calls the deliverability query directly through the app's ConvexReactClient from the browser console — the shipped UI never calls it, so nothing in the interface reveals that the data is reachable.

### Conditions and containment

- **authentication_level**: Registered, authenticated user provisioned in the Convex users table.
- **authorization_role**: Plain member of the organisation who is not named on the restricted project and is not its creator (admins and owners see everything by design). Cross-organisation reads are not possible: requireOrgMember rejects a foreign orgId with not_a_member, verified locally.
- **data_state**: At least one candidate has been invited to a restricted project of the org and the resulting emailLog row is within the newest 200 (the query's hard cap); for the count variant, at least one session exists on a project the caller cannot see.

### Native input and bounded instructions

Inputs:

- `api.emailEvents.recent { orgId: <own org id>, limit: 200 }`
- `api.sessions.countsForOrg { orgId: <own org id> } differenced against api.dashboard.overview { orgId, now }`

Instructions:

1. Verifier re-check, independent of the hunter's harness (no deployment, no network, no dependency installation). From /root/security-audit-skill/interw/run-1/agents/verifier-v05/scratch, run: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v05 'node --experimental-strip-types --import ./vtmp/register.mjs ./verify-harness.mjs' (new mount+net namespace with no interfaces, read-only target, env -i, prlimit cpu=20 fsize=8MiB nofile=256 nproc=64, 60 s wall clock).
2. verify-harness.mjs imports the real convex/emailEvents.ts, sessions.ts, reports.ts, projects.ts, dashboard.ts and lib/{auth,projectAccess}.ts with only convex/values, convex/server, convex/_generated/*, convex/auth.ts, convex/email.ts, convex/emailTemplates.ts, @convex-dev/resend and @convex-dev/rate-limiter stubbed, and seeds a dummy org holding a restricted project (creator = owner, one share to a different member) with a pending session and its candidate-invitation emailLog row, plus an unrestricted project with its own session and row. Every handler is then called as the excluded plain member, with the shared member and a foreign orgId as controls.
3. Read section V2 of scratch/verify-harness.log (promote this file as evidence: it is the file the confirmed observed_result below is taken from).

### Observed output and invariant proved

As the excluded member: V2.1 projects.list -> ['closed-role','live-role'] (the restricted 'secret-role' is absent); V2.2 sessions.listByProject(secret-role) -> {ok:false, error:'not_found'}; V2.3 reports.forSession(hidden session) -> {ok:false, error:'not_found'}; V2.4 reports.searchCandidates('Secret') -> []; V2.5 dashboard.overview -> {pending:1, activeRoles:2} (the hidden session excluded). Then the derived reads: V2.6 emailEvents.recent(orgId) -> two rows, including {template:'candidate-invitation', recipient:'sam@secret.test', status:'sent', sessionId:<hidden session id>, createdAt:3}, i.e. the hidden candidate's address, invitation time and session id; V2.7 sessions.countsForOrg(orgId) -> {total:2, completed:0, inProgress:0, pending:2} against dashboard.overview's pending:1, a one-session difference that counts the hidden role. Controls: V2.8 the member named on the share does see the candidate through searchCandidates (1 result), so the visibility layer itself works; V2.9 emailEvents.recent with a foreign orgId -> {ok:false, error:'not_a_member'}, so the org boundary holds.

### Remediation and regression

Apply the same project-visibility predicate to the derived reads as to the primary ones: resolve each emailLog row's session to its project and drop the rows the caller cannot see (or denormalise projectId onto emailLog and filter through filterVisibleProjects, which also lets an index carry it), and restrict countsForOrg to visible projects the way dashboard.overview already does. Deleting emailEvents.recent outright is also acceptable — it has no caller under src/ — but the count variant still has to be fixed, and any future deliverability surface must be written with the filter in place.

`convex/emailEvents.ts`:

```ts
import { canSeeProject } from './lib/projectAccess'

/** Recent delivery outcomes for an organisation, newest first. */
export const recent = query({
  args: { orgId: v.id('organizations'), limit: v.optional(v.number()) },
  handler: async (ctx, { orgId, limit }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    const rows = await ctx.db
      .query('emailLog')
      .withIndex('by_org_and_created', (q) => q.eq('orgId', orgId))
      .order('desc')
      .take(Math.min(limit ?? 50, 200))

    // A row that names a candidate inherits the visibility of that
    // candidate's role: a confidential search must not leak through the
    // deliverability list any more than through the search box.
    const seen = new Map<string, boolean>()
    const visible = []
    for (const row of rows) {
      if (row.sessionId) {
        const session = await ctx.db.get('sessions', row.sessionId)
        if (!session) continue
        let ok = seen.get(session.projectId)
        if (ok === undefined) {
          const project = await ctx.db.get('projects', session.projectId)
          ok = project
            ? await canSeeProject(ctx, project, user._id, member.role)
            : false
          seen.set(session.projectId, ok)
        }
        if (!ok) continue
      }
      visible.push({
        _id: row._id,
        template: row.template,
        recipient: row.recipient,
        status: row.status,
        error: row.error ?? null,
        sessionId: row.sessionId ?? null,
        createdAt: row.createdAt,
      })
    }
    return visible
  },
})
```

`convex/sessions.ts`:

```ts
export const countsForOrg = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    // Same filter as dashboard.overview: a count of sessions on a role the
    // caller cannot see is still a disclosure of that role.
    const projects = await filterVisibleProjects(
      ctx,
      await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', orgId))
        .take(200),
      user._id,
      member.role,
    )
    const visible = new Set(projects.map((project) => project._id))
    const recent = (
      await ctx.db
        .query('sessions')
        .withIndex('by_org', (q) => q.eq('orgId', orgId))
        .order('desc')
        .take(500)
    ).filter((session) => visible.has(session.projectId))
    return {
      total: recent.length,
      completed: recent.filter((s) => s.status === 'completed').length,
      inProgress: recent.filter((s) => s.status === 'in_progress').length,
      pending: recent.filter((s) => s.status === 'pending').length,
    }
  },
})
```

`convex/guards.test.ts`:

```ts
it('does not leak a restricted role\u2019s candidates through the deliverability list', async () => {
  const rows = await as(t, 'acmeMember').query(api.emailEvents.recent, {
    orgId: w.acmeOrgId,
  })
  expect(
    rows.map((row) => row.recipient),
  ).not.toContain('hidden@candidate.test')
})
```

## MEDIUM — A cancelled or archived candidate link can still finish the interview, reversing the recruiter's revocation and starting the paid pipeline

Fingerprint: `convex/interview.ts:finish:bypasses-session-gate`

Every other candidate write in convex/interview.ts goes through requireOpenSession, which applies the shared gate in convex/lib/sessionState.ts and refuses a session the recruiter cancelled ('cancelled'), a role that is draft or archived ('closed'), and a session whose own status is 'expired'. interview.finish alone resolves the token with resolveSessionByToken and returns early only when the status is already 'completed'. A holder of the link therefore calls the public mutation once and the session becomes a completed interview: status is overwritten to 'completed', purgeAfter is reset from the invitation clock to now + 365 days, the project's completedSessionCount is incremented, and internal.pipeline.onSessionCompleted is scheduled. onSessionCompleted reads no session or project status — it filters segments by uploadState only — so every answer uploaded before the cancellation is enqueued for paid transcription, then a paid report completion, then a report-ready email naming the candidate to the project creator and every organisation member (take(200)) or everyone named on a restricted role. The recruiter cannot undo it: sessions.cancel refuses a completed session, leaving deleteCandidateData (destroying the candidate's data outright) as the only remaining recourse. The handler's own comment documents one intended exception — a role that 'expired a minute ago' — and the code implements no exception at all, it simply drops the gate.

**Root cause.** interview.finish (convex/interview.ts:481-515) uses resolveSessionByToken instead of requireOpenSession and checks only session.status === 'completed'. Dropping the whole gate to permit the documented project-expiry exception also drops the terminal session state 'cancelled' (and 'expired'), the project-level 'closed' state for draft/archived roles, and the consent/started precondition. convex/pipeline.ts:onSessionCompleted has no status precondition of its own to compensate.

**Intended behaviour.** convex/lib/sessionState.ts states the gate is the single answer to 'can this person record right now?', and treats cancelled/expired/completed as terminal states that win over everything (line 67-69); sessions.cancel exists to 'close a link' and the recruiter is told the candidate's link will stop working. A revoked or archived link must not be able to change the session's state, trigger provider spend, extend retention, or notify the organisation. Only the documented case — the role's own expiresAt having passed while the candidate was finishing — should be forgiven.

### Trace

1. **entrypoint** `convex/interview.ts:481` — finish (public mutation, args { token: v.string() }): Public candidate mutation reachable with nothing but the link token; no account, no gate argument.
2. **propagation** `convex/interview.ts:490` — finish handler: Token resolved with resolveSessionByToken (existence only). requireOpenSession, which every other candidate write uses, is deliberately not called.
3. **propagation** `convex/interview.ts:491` — finish handler: The only state check: short-circuit when status is already 'completed'. 'cancelled', 'expired', 'pending' and 'in_progress' all fall through, on an active, draft or archived project alike.
4. **propagation** `convex/interview.ts:497` — finish handler, ctx.db.patch('sessions'): Session status overwritten to 'completed' with completedAt and lastActivityAt set.
5. **propagation** `convex/interview.ts:504` — finish handler, ctx.db.patch('sessions'): purgeAfter reset to now + RETENTION_MS (365 days, interview.ts:518), replacing the shorter invitation-based clock of a session that was never completed.
6. **propagation** `convex/interview.ts:506` — finish handler, ctx.db.patch('projects'): project.completedSessionCount incremented, so the recruiter's own counts record the withdrawn interview as completed.
7. **propagation** `convex/interview.ts:510` — finish handler, ctx.scheduler.runAfter: internal.pipeline.onSessionCompleted scheduled for this session.
8. **propagation** `convex/pipeline.ts:119` — onSessionCompleted: Segments are filtered by uploadState === 'uploaded' only; neither session.status nor project.status is read, so a cancelled-then-flipped session is processed like any other.
9. **propagation** `convex/pipeline.ts:160` — onSessionCompleted, mediaPool.enqueueAction: One transcribeSegment job enqueued per previously uploaded answer on the deployment-wide media workpool.
10. **propagation** `convex/pipeline.ts:267` — transcribeSegment: Paid provider transcription call for each of those answers.
11. **propagation** `convex/pipeline.ts:600` — generateReport: Paid evaluation model completion produces the report for a candidate the organisation had withdrawn.
12. **sink** `convex/notifications.ts:109` — sendReportReady: Report-ready email carrying the candidate's name, score and recommendation sent to the project creator and every organisation member (take(200) at line 89) or everyone named on a restricted role.

### Evidence

- `convex/lib/sessionState.ts:68` — evaluateSessionGate returns blocked('cancelled') for a cancelled session: 'Terminal session states win over everything'.
- `convex/lib/sessionState.ts:78` — A draft or archived project is blocked with 'closed': 'nobody should be able to sit an interview that is not live, including through a link that was sent while it was'.
- `convex/interview.ts:73` — requireOpenSession throws gate.state for anything but 'ready'/'resumable'; it is the gate used by questions, start, reserveSegment, markSegmentUploaded and markSegmentFailed, and not by finish.
- `convex/interview.ts:485` — The comment justifying the missing gate names one case only — a role that 'expired a minute ago' — while the code implements no case distinction whatsoever.
- `convex/sessions.ts:279` — sessions.cancel (owner or admin only) writes status 'cancelled' and nothing else; it relies entirely on the gate to make the link stop working.
- `convex/sessions.ts:278` — cancel throws 'session_closed' once the session is completed, so the candidate-driven flip cannot be re-cancelled; only the destructive deleteCandidateData (sessions.ts:341) remains.
- `convex/pipeline.ts:123` — Only a session with zero uploaded segments is skipped; anything recorded before the cancellation is transcribed and scored.
- `convex/projects.ts:308` — projects.archive documents that archiving cuts every candidate's link 'with no warning and no way for them to finish' — an invariant finish does not honour.
- `src/locales/en/candidates.json:76` — Recruiter-facing confirmation copy for cancel: the candidate's link will stop working.
- `src/routes/s/$token/interview.tsx:305` — The candidate page calls api.interview.finish with the token from the final screen, so no custom client is required when a cancellation lands while the candidate is on that screen.

### Principal and resource

A candidate whose link the recruiter cancelled (the candidate page tells them 'cancelled') calls the public mutation api.interview.finish with their token from an ordinary Convex client — exactly the call the interview page makes after the last answer. The session becomes a completed interview, the pipeline runs on whatever was uploaded before the cancellation, and the organisation is emailed a report for a candidate it withdrew.

### Conditions and containment

- **authentication_level**: Attacker holds a candidate session access token (the invited candidate, or anyone the invitation email was forwarded to). No account and no other credential.
- **authorization_role**: A project owner or admin previously called sessions.cancel on that session, or archived the role / left it in draft — the recruiter decision being overridden.
- **data_state**: Session status is anything but 'completed' ('cancelled', 'expired', 'pending' or 'in_progress'). At least one segment in uploadState 'uploaded' is needed for provider spend and the email; with zero segments the status flip, the retention reset and the counter increment still happen.

### Native input and bounded instructions

Inputs:

- `api.interview.finish({ token: "<accessToken of a session whose status is 'cancelled'>" })`
- `api.interview.finish({ token: "<accessToken of an in_progress session whose project.status is 'archived'>" })`
- `dummy session { status: 'cancelled', lastQuestionIndex: 1, consentAcceptedAt: 1 } with project { status: 'active' } passed to evaluateSessionGate for comparison`

Instructions:

1. Bounded local check only; no deployment, endpoint or external service was contacted. From the verifier scratch directory run: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v01 'node --experimental-strip-types --import ./register.mjs ./harness.ts' (no network namespace, read-only target, empty environment, prlimit/timeout as configured).
2. harness.ts imports the UNMODIFIED repository modules /home/user/interw/convex/interview.ts, /home/user/interw/convex/pipeline.ts and /home/user/interw/convex/lib/sessionState.ts through loader hooks (hooks.mjs) that substitute inert stubs for convex/values, convex/server, convex/_generated/*, @convex-dev/* and zod, plus a stub for convex/lib/ai and convex/lib/objectStore so no provider or bucket call can leave the sandbox. ctx.mjs is an in-memory ctx.db/ctx.scheduler.
3. Check A evaluates evaluateSessionGate on dummy rows: cancelled session / active project, in_progress / archived, in_progress / draft, expired / active, and an in_progress / active control.
4. Check B seeds a dummy organisation, project, question, session (one uploaded segment) for each of statuses cancelled, expired, pending, in_progress and completed, and calls the real finish.handler with the token, printing the session's status and purgeAfter before and after, the project's completedSessionCount and the scheduler queue.
5. Check B2 patches a seeded in_progress session to 'cancelled' (the state sessions.cancel writes), calls the real finish.handler, then re-reads the row against the sessions.cancel guard at convex/sessions.ts:278.
6. Check C calls the real pipeline.onSessionCompleted.handler on the cancelled-then-finished session (three uploaded segments) with a stub workpool that records enqueues instead of performing them.
7. This record's observed_result is taken from the promoted scratch file verify.log, written by that sandbox run.
8. Owner regression (not run here; node_modules is absent and installation is prohibited): add a convex-test case in convex/interview.test.ts that seeds an active project with one question, invites a candidate, uploads one answer, calls sessions.cancel as the owner, then calls api.interview.finish with the token and expects ConvexError('cancelled'), an unchanged session row and an empty scheduler.

### Observed output and invariant proved

Check A (target gate): cancelled/active -> state=cancelled canRecord=false; in_progress/archived -> closed; in_progress/draft -> closed; expired/active -> expired; in_progress/active control -> resumable canRecord=true. Check B (unmodified finish handler): status=cancelled -> no throw, returned {"alreadyCompleted":false}, status cancelled->completed, purgeAfter 15811200000->now+31536000000, completedSessionCount=1, scheduled=["pipeline.onSessionCompleted"]; identical outcome for status=expired, status=pending (no consent) and status=in_progress; status=completed returned {"alreadyCompleted":true} with nothing changed and nothing scheduled. Check B2: after the recruiter's cancel the row read 'cancelled', finish returned {"alreadyCompleted":false} and left status=completed, at which point convex/sessions.ts:278 refuses a second cancel. Check C: onSessionCompleted on that cancelled-then-finished session enqueued ["pipeline.transcribeSegment","pipeline.transcribeSegment","pipeline.transcribeSegment"] on mediaPool and set session.segmentsExpected=3, with no status precondition consulted.

### Remediation and regression

Make finish consult the same gate as every other candidate transition and forgive only the case the comment documents. Proceed when the gate is 'ready' or 'resumable', or when the sole blocker is the role's own expiresAt having passed on a still-active role; reject 'cancelled', 'closed' and a session whose own status is 'expired' by throwing the gate state, exactly as requireOpenSession does. Additionally require that the interview actually started (status 'in_progress' with consent), so a pending session that recorded nothing cannot be flipped to completed either. Cover it with convex-test regressions for the cancelled and the archived case asserting the row is unchanged and the scheduler empty.

`convex/interview.ts`:

```ts
export const finish = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const now = Date.now()
    const session = await resolveSessionByToken(ctx, token)
    if (session.status === 'completed') return { alreadyCompleted: true }
    await consumeLimit(ctx, 'candidateWrite', token)

    const project = await ctx.db.get('projects', session.projectId)
    if (!project) throw new ConvexError('not_found')

    // The one tolerated blocker is the role's own expiry: a candidate who has
    // just recorded must still be able to finish if the deadline passed a
    // minute ago. A cancelled link, a session that is itself expired, and a
    // role that is not live are all terminal here, as they are everywhere else.
    const gate = evaluateSessionGate({ session, project, now })
    const roleJustExpired =
      gate.state === 'expired' &&
      session.status !== 'expired' &&
      project.status === 'active'
    if (gate.state !== 'ready' && gate.state !== 'resumable' && !roleJustExpired) {
      throw new ConvexError(gate.state)
    }
    // Nothing to finish if nothing was ever started.
    if (session.status !== 'in_progress' || session.consentAcceptedAt === undefined) {
      throw new ConvexError('not_started')
    }

    // ... unchanged: patch the session, the counter, and schedule
    // internal.pipeline.onSessionCompleted
  },
})
```

`convex/interview.test.ts`:

```ts
it('a cancelled link cannot finish the interview', async () => {
  await t.run(async (ctx) => {
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_token', (q) => q.eq('accessToken', s.token))
      .unique()
    await ctx.db.patch('sessions', session!._id, { status: 'cancelled' })
  })
  await expect(t.mutation(api.interview.finish, { token: s.token })).rejects.toThrow('cancelled')
  const after = await t.run(async (ctx) =>
    ctx.db.query('sessions').withIndex('by_token', (q) => q.eq('accessToken', s.token)).unique(),
  )
  expect(after!.status).toBe('cancelled')
})

it('an archived role cannot be finished through the link', async () => {
  await t.run(async (ctx) => {
    await ctx.db.patch('projects', s.projectId, { status: 'archived' })
  })
  await expect(t.mutation(api.interview.finish, { token: s.token })).rejects.toThrow('closed')
})
```

## MEDIUM — Removing an organisation member leaves their projectShares row and createdBy attribution in place, so they keep receiving candidate report emails and regain restricted-role visibility if re-invited

Fingerprint: `convex/organizations.ts:removeMember:projectShares-not-revoked`

convex/organizations.ts removeMember deletes only the organizationMembers row. Two authorisations keyed on the same user id survive it: the projectShares rows that named the person on restricted roles, and the createdBy attribution on any role they created. convex/notifications.ts sendReportReady, which the pipeline runs after every generated report, builds its recipient list from exactly those two sources and never consults organizationMembers, so every interview completed after the removal emails the ex-member the candidate's name, the job title, the overall score and the recommendation. The surviving share row also makes convex/lib/projectAccess.ts canSeeProject return true again the moment the same person is re-invited as a plain member, restoring read access to a role they were never re-granted. Affected owner: the recruiter organisation. Lower-trust principal: an ex-member whose access was explicitly revoked. Protected data: candidate PII and AI assessment results. Reproduced locally against the real handlers.

**Root cause.** removeMember treats the organizationMembers row as the only authorisation to revoke. projectShares is a derived grant that setShares (convex/projects.ts:396-403) only ever issues to a current member, yet it is deleted at just two sites — project removal (projects.ts:375) and a later setShares (projects.ts:413) — neither of which runs on member removal. sendReportReady then trusts project.createdBy (notifications.ts:81) and every projectShares.userId (notifications.ts:87) as its audience with no membership re-check; its only filter (notifications.ts:100) skips a user whose users row is gone, which a removed member's is not. canSeeProject (lib/projectAccess.ts:36-42) trusts the same persisted row once membership is re-established.

**Intended behaviour.** Removing a member is a revocation: after it, no later operation should act on that person's behalf inside the organisation, and no organisation data should reach them. Project sharing is documented as a soft boundary strictly inside the org membership boundary (lib/projectAccess.ts:4-10), and setShares enforces that by rejecting a non-member with 'not_a_member' — so a share must not outlive the membership that made it legal. sendReportReady's own comment states the recipient list is 'derived server-side from org membership and project sharing'; membership is in fact never consulted on the restricted branch, nor for project.createdBy.

### Trace

1. **entrypoint** `convex/organizations.ts:196` — removeMember (public mutation): An org admin or owner calls removeMember for the target membership row; requireOrgRole, the owner_only and last_owner rules and the target.orgId re-check all pass.
2. **propagation** `convex/organizations.ts:214` — removeMember: The handler's only write is the deletion of the organizationMembers row. Nothing touches projectShares or any audience derived from the removed user id.
3. **propagation** `convex/projects.ts:419` — setShares: The projectShares row naming the (then) member on a restricted role was inserted here and persists; the only deletion sites are project removal (line 375) and a later setShares (line 413).
4. **propagation** `convex/pipeline.ts:681` — notifyRecruiter: After every generated report, notifyRecruiter runs internal.notifications.sendReportReady for the session.
5. **propagation** `convex/notifications.ts:81` — sendReportReady: The recipient set is seeded with project.createdBy with no membership check, so an ex-member who created the role is always included, on restricted and open roles alike.
6. **propagation** `convex/notifications.ts:87` — sendReportReady: For a restricted role every projectShares.userId is added to the recipient set, again without consulting organizationMembers.
7. **sink** `convex/notifications.ts:109` — sendReportReady: resend.sendEmail delivers the report-ready message to user.email; the body built at lines 101-108 carries candidateName, jobTitle, overallScore and recommendation, and an emailLog row is written for the ex-member.

### Evidence

- `convex/organizations.ts:214` — removeMember's sole write: ctx.db.delete on organizationMembers. No projectShares cleanup anywhere in the file (grep for projectShares across convex/ returns no hit in organizations.ts).
- `convex/projects.ts:403` — setShares refuses to name a non-member ('not_a_member'), establishing that a share is only ever legal for a current member — the policy removeMember fails to maintain.
- `convex/projects.ts:375` — First of only two projectShares deletion sites (cascade on project removal); neither runs on member removal.
- `convex/projects.ts:413` — Second and last projectShares deletion site (a later setShares dropping a user from the list).
- `convex/notifications.ts:81` — Recipient set seeded from project.createdBy with no membership check.
- `convex/notifications.ts:87` — Recipient set extended with every projectShares.userId with no membership check.
- `convex/notifications.ts:100` — The only recipient filter: 'if (!user) continue' skips a user whose users row was deleted. A removed member's users row still exists, so the filter does not apply to them.
- `convex/emailTemplates.ts:651` — Report-ready subject carries the candidate's name and the job title.
- `convex/emailTemplates.ts:654` — Report-ready body carries the overall score out of 100 and the recommendation.
- `convex/lib/projectAccess.ts:36` — canSeeProject consults the persisted projectShares row by (projectId, userId), so a removed-then-re-invited plain member regains visibility on the restricted role.
- `convex/lib/projectAccess.ts:8` — The module docstring states project visibility is a soft boundary nested inside org membership, which is 'the hard boundary' — the invariant the surviving share row violates.
- `convex/users.ts:187` — Contrast: account deletion (cascadeDelete) also leaves projectShares behind, but it deletes the users row, so notifications.ts:100 skips those ids. The leak is specific to removeMember, which keeps the users row alive.

### Principal and resource

An ex-member of the recruiter organisation — offboarded staff, a contractor whose engagement ended, or a colleague removed after a dispute. They take no action at all for the primary effect: the product keeps mailing them each new candidate's name, the role, the AI score and the hire/no-hire recommendation. For the secondary effect they only need to be re-invited as an ordinary member, after which the confidential role they were never re-shared on is readable again.

### Conditions and containment

- **authorization_role**: An org admin or owner performs the removal through the normal Members UI; no attacker privilege is needed for the removal itself.
- **data_state**: The removed user was either named on a restricted role via setShares, or is the createdBy of any role in the org (restricted or open).
- **timing_dependency**: At least one interview on such a role reaches a generated report after the removal; sendReportReady is idempotent per session, so only reports produced after the removal are affected.
- **environmental_dependency**: Real delivery requires RESEND_TEST_MODE='false' in the Convex deployment (convex/email.ts:15); with the default test mode the recipient list and the emailLog rows are still built the same way.
- **user_interaction**: For the secondary effect only: the removed person is later re-invited to the same organisation as a plain member.

### Native input and bounded instructions

Inputs:

- `organizations.removeMember({ orgId: <acme>, memberId: <membership row of B> })  // performed by the org owner, normal UI action`
- `notifications.sendReportReady({ sessionId: <session completed after the removal> })  // internal, run by pipeline.notifyRecruiter after every report`
- `projects.getBySlug({ orgId: <acme>, slug: 'confidential-vp' })  // called by B after being re-invited as a plain member`

Instructions:

1. Bounded local reproduction, no network and no deployed endpoint. Harness at scratch/removemember-shares.mjs with the stub loader at scratch/tmp/loader.mjs and stubs under scratch/tmp/stubs/; transcript retained at scratch/removemember-shares.log (referenced as the confirmed observed_result — please promote it).
2. It loads the REAL convex/organizations.ts, convex/projects.ts, convex/notifications.ts, convex/lib/auth.ts, convex/lib/projectAccess.ts and convex/emailTemplates.ts under `node --experimental-strip-types`, against an in-memory fake of ctx.db. Only convex/values, convex/server, convex/_generated/*, convex/auth.ts (identity) and convex/email.ts (records sends) are stubbed; @convex-dev/* are stubbed because node_modules is absent.
3. Seed a dummy tenant 'acme' with owner A and member B, both plain dummy users. Create role P1 and share it with B through the real projects.setShares handler as A (this sets projects.restricted = true and inserts the projectShares row). Create role P2 with createdBy = B.
4. As A, call the real organizations.removeMember handler for B's membership row.
5. Assert the control still holds: as B, the real projects.list handler throws 'not_a_member'.
6. Insert one completed session plus a reports row on each of P1 and P2, dated after the removal, with fictional candidate names.
7. Run the real notifications.sendReportReady handler for each session and read back the recipients recorded by the convex/email.ts stub and the emailLog rows written to the fake db.
8. Re-insert B as role 'member' and call the real lib/projectAccess.ts canSeeProject and the real projects.getBySlug handler for the restricted role.
9. Command: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v06 'cd /root/security-audit-skill/interw/run-1/agents/verifier-v06 && node --experimental-strip-types --import ./scratch/tmp/register.mjs ./scratch/removemember-shares.mjs' (env -i, no network namespace, read-only repo, prlimit, 60 s wall clock).

### Observed output and invariant proved

removeMember returned null and left organizationMembers with only the owner, while the projectShares row {projectId: P1, userId: B} survived unchanged and P2.createdBy still pointed at B. The revocation control itself held: B calling projects.list threw 'not_a_member'. sendReportReady then returned true for both sessions and the email stub recorded four provider sends, two of them to exmember@acme.test: 'Dana Fictional — interview report ready (VP Engineering)' and 'Rene Fictional — interview report ready (Staff Engineer)', whose bodies read 'Dana Fictional has completed their interview for VP Engineering. / Overall score: 87/100. Recommendation: strong_yes.' and 'Rene Fictional has completed their interview for Staff Engineer. / Overall score: 41/100. Recommendation: no.' Two emailLog rows were written with recipient exmember@acme.test and template 'report-ready'. After re-inserting B as a plain 'member', canSeeProject(P1, B, 'member') returned true and projects.getBySlug('confidential-vp') returned the project instead of throwing 'not_found' — restricted: true, title 'Confidential VP'. Dummy tenant and fictional candidate data only; stopped at the minimum observable record.

### Remediation and regression

Fix it in both places, because they fail differently. (1) In removeMember, delete the removed user's projectShares rows for that organisation in the same mutation, so the grant cannot outlive the membership that made it legal — this is what closes the re-invite path through canSeeProject, which no downstream filter can undo. (2) In sendReportReady, re-derive the audience against organizationMembers at send time instead of trusting project.createdBy and the share rows, so any other stale attribution (an account deleted and re-provisioned, a share row missed by a future code path) cannot reach the sink either. Neither change moves trust: membership is already the hard boundary that setShares enforces at grant time, so both edits simply re-assert it at revoke time and at use time. Note the side effect of (1): removing the last shared member leaves projects.restricted true with no share rows, which narrows visibility to the creator and admins — fail-closed, and setShares recomputes the flag on the next edit. Add a regression test to convex/guards.test.ts asserting that after removeMember no emailLog row names the removed user and that getBySlug on the restricted role throws not_found for them once re-invited.

`convex/organizations.ts`:

```ts
// convex/organizations.ts — removeMember: revoke every authorisation keyed on
// the user id, not just the membership row.
export const removeMember = mutation({
  args: {
    orgId: v.id('organizations'),
    memberId: v.id('organizationMembers'),
  },
  handler: async (ctx, { orgId, memberId }) => {
    const { user, member: acting } = await requireOrgRole(ctx, orgId, 'admin')
    const target = await ctx.db.get("organizationMembers", memberId)
    if (!target || target.orgId !== orgId) throw new ConvexError('not_found')
    if (target.role === 'owner') {
      if (acting.role !== 'owner') throw new ConvexError('owner_only')
      const owners = await countOwners(ctx, orgId)
      if (owners <= 1) throw new ConvexError('last_owner')
    }
    if (target.userId === user._id && acting.role === 'owner') {
      const owners = await countOwners(ctx, orgId)
      if (owners <= 1) throw new ConvexError('last_owner')
    }

    // Project sharing is a grant that was only ever legal because the person
    // was a member (setShares rejects a non-member with `not_a_member`), so it
    // dies with the membership. Leaving these rows behind keeps the removed
    // user on the report-ready audience and silently restores their visibility
    // on restricted roles if they are ever re-invited.
    const shares = await ctx.db
      .query('projectShares')
      .withIndex('by_user', (q) => q.eq('userId', target.userId))
      .collect()
    for (const share of shares) {
      if (share.orgId !== orgId) continue
      await ctx.db.delete('projectShares', share._id)
    }

    await ctx.db.delete("organizationMembers", memberId)
    return null
  },
})
```

`convex/notifications.ts`:

```ts
// convex/notifications.ts — sendReportReady: membership is the hard boundary,
// so it is re-checked for every recipient at send time. A share row or a
// `createdBy` attribution is a visibility hint inside an org, never an
// authorisation that outlives the org membership it was granted under.
    const candidates = new Set<Id<'users'>>([project.createdBy])
    if (project.restricted) {
      const shares = await ctx.db
        .query('projectShares')
        .withIndex('by_project', (q) => q.eq('projectId', project._id))
        .collect()
      for (const share of shares) candidates.add(share.userId)
    } else {
      const members = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org', (q) => q.eq('orgId', session.orgId))
        .take(200)
      for (const member of members) candidates.add(member.userId)
    }

    const recipients = new Set<Id<'users'>>()
    for (const userId of candidates) {
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', session.orgId).eq('userId', userId),
        )
        .unique()
      if (membership) recipients.add(userId)
    }
```

## MEDIUM — The assessed candidate supplies the answer length that drives the recruiter report's para-verbal "measurements" and every quote anchor

Fingerprint: `convex/pipeline.ts:reportInputs:candidate-reported-durationSeconds-in-report`

The length of each answer is reported by the candidate's own browser. interview.markSegmentUploaded takes durationSeconds: v.number() from the candidate (token-gated, no other caller) and stores Math.max(0, Math.round(...)) on the segment with no upper bound and no cross-check against anything the server observed. pipeline.reportInputs copies that number into the report inputs, generateReport hands it to computeParaverbal, and buildReport hands it to chooseStartSeconds for every evidence quote and to the highlight clamp. The recruiter page and the public share page then present the result as measured fact: the Delivery card is titled with the copy "Measured from the transcript timings, not judged by a model" (src/locales/en/report.json:56) and the schema calls the section "Computed, not generated" (convex/schema.ts:207). Reproduced locally: for one unchanged, provider-timed transcript, sending 8 vs 60 seconds moves concision 0.5 -> 10 and engagement 1.4 -> 10 (pace 10 -> 0); for a 100-word answer actually recorded over 120 s, claiming 48 s moves pace 0 -> 10, concision 2.5 -> 10 and silence 9.7 -> 4.2. Independently, a forged duration of 1 drags every anchored citation to 0:00 while the report still flags it anchored: true, so the "jump to 0:12" buttons on both the recruiter page and the share page land on the wrong moment — the exact failure the code comments in convex/lib/evidence.ts:84-90 and convex/lib/ai.ts:199-203 say must never be produced. The server already holds an unforgeable length (the provider's usage.total_seconds, returned as audioSeconds by lib/ai.ts:217) and uses it only for a jobLog row.

**Root cause.** convex/pipeline.ts:reportInputs (line 472) propagates segment.durationSeconds — a raw client argument accepted at convex/interview.ts:380-401 with only a floor at 0 and a rounding — as the authoritative answer length for computeParaverbal and chooseStartSeconds, instead of deriving it from data the server observed (the provider's usage.total_seconds already returned by convex/lib/ai.ts:217 but only written to jobLog at convex/pipeline.ts:283, or the last transcript chunk end stored by saveTranscript), and without bounding the stored value by the question's maxResponseSeconds at write time.

**Intended behaviour.** The para-verbal dimensions and the quote timecodes are deterministic measurements over data the product itself observed, as the schema comment and the recruiter-facing copy both state. A candidate must be able to influence their own assessment only through what they actually said and how they actually said it, never by reporting the measurement.

### Trace

1. **entrypoint** `convex/interview.ts:380` — markSegmentUploaded (public Convex mutation, candidate-token gated): Public mutation whose args (line 384) include durationSeconds: v.number(), supplied by whoever holds the candidate session token; requireOpenSession (line 388) uses the server clock, so the only precondition is an open session.
2. **propagation** `convex/interview.ts:400` — markSegmentUploaded handler: Patches the segment with durationSeconds: Math.max(0, Math.round(durationSeconds)) — no upper bound, no finiteness check, no comparison with the question's maxResponseSeconds or with any server-observed timing.
3. **propagation** `convex/pipeline.ts:472` — reportInputs (internalQuery): Copies segment.durationSeconds ?? null into the per-answer report input, alongside maxResponseSeconds (line 473) taken from the question.
4. **propagation** `convex/pipeline.ts:618` — generateReport (internalAction): Passes answer.durationSeconds ?? 0 to computeParaverbal (called at line 615); the result is persisted by saveReport into reports.paraverbal (line 626, schema.ts:507).
5. **propagation** `convex/lib/reportBuilder.ts:87` — buildReport.anchor: Passes answer.durationSeconds into chooseStartSeconds for every evidence quote (called for criterion evidence at line 119 and for each evaluation at line 141); the same number clamps every highlight clip at line 162.
6. **propagation** `convex/lib/paraverbal.ts:159` — computeParaverbal: answer.durationSeconds / answer.maxResponseSeconds is the usage ratio that scores concision (line 209) and engagement (line 229); the same number is the denominator of wordsPerMinute for pace (lines 142-147, 176), of the silence ratio for pauses (lines 151-155, 197) and of the answer-length spread for consistency (lines 165-169, 219). It is also the filter that decides whether an answer counts at all (line 132).
7. **propagation** `convex/lib/evidence.ts:106` — chooseStartSeconds: The transcript-resolved offset is clamped with Math.min(resolved, Math.max(0, durationSeconds - 1)), so a forged small duration overrides the authoritative transcript timing while the quote is still returned with anchored: true (reportBuilder.ts:93).
8. **sink** `src/routes/app/$orgSlug/candidates.$sessionId.tsx:563` — candidate report page, Delivery card: Renders each para-verbal dimension's score and raw measure to the recruiter under copy asserting they are measured from transcript timings; the clamped startSeconds drives the seek buttons at lines 336 and 452.

### Evidence

- `src/locales/en/report.json:56` — Recruiter-facing copy for the Delivery card: "Measured from the transcript timings, not judged by a model." Three of the six numbers under it (Time used, Engagement "seconds spoken", and the denominator of Speaking rate) come from the candidate's argument, not from transcript timings.
- `convex/schema.ts:207` — "Computed, not generated — see paraverbalDimensionValidator"; the block at lines 100-110 states the product must not present an invention as a measurement.
- `src/lib/media/recorder.ts:221` — The honest client derives durationSeconds from Math.round((Date.now() - this.startedAt) / 1000) in the browser — client data by construction, with nothing the server can check it against.
- `src/routes/s/$token/interview.tsx:221` — That browser-computed value is sent verbatim as the durationSeconds argument of api.interview.markSegmentUploaded, so an attacker only has to replace one number in an ordinary client call.
- `convex/schema.ts:459` — segments.durationSeconds is an unconstrained optional number; nothing in the schema bounds it by the question's maxResponseSeconds.
- `convex/lib/ai.ts:217` — transcribe() returns audioSeconds from the provider's usage.total_seconds — an unforgeable server-observed length that is available for every segment.
- `convex/pipeline.ts:283` — That provider-measured length is passed only to recordJob as jobLog.audioSeconds; saveTranscript (lines 204-232) never writes any server-measured duration back onto the segment, so the client number is never corrected.
- `convex/lib/reportBuilder.ts:162` — Highlight clips are clamped to the same client-reported duration, so a forged small value also truncates or collapses every highlight the report offers.
- `convex/lib/evidence.ts:89` — The module's own contract: "A quote with no timestamp is still worth showing; a wrong timestamp is not." The client-controlled clamp at line 106 produces exactly a wrong timestamp that is still marked anchored.
- `convex/shares.ts:266` — The same paraverbal object and anchored evidence are returned to any holder of a report share link (validator at line 191), so the forged numbers are not confined to the recruiter's own session page (share page seek button: src/routes/r/$shareToken.tsx:212).

### Principal and resource

An invited candidate answers normally, uploads the media through the ordinary presigned PUT, then calls api.interview.markSegmentUploaded with a durationSeconds of their choosing rather than the recorder's: a value placing the usage ratio in the ideal band (about 0.4-0.85 of the question's limit) to push concision and engagement to 10/10 and, by changing the words-per-minute denominator, pace as well; or a value of 1 to drag every anchored citation in the report to 0:00 while it is still flagged as anchored. The recruiter — and anyone holding a share link — sees those numbers on the Delivery card under copy stating they were measured from the transcript timings.

### Conditions and containment

- **authentication_level**: Attacker holds a valid candidate session access token (the invited candidate, or anyone the invitation link was forwarded to). No account, no org membership and no recruiter privilege.
- **data_state**: The session must still be open when the mutation is called (requireOpenSession, convex/interview.ts:388, evaluated on the server clock), and the segment must belong to that session (convex/interview.ts:392-395) — i.e. the ordinary state during the interview, before interview.finish.
- **user_interaction**: None beyond the candidate issuing the mutation with a chosen number instead of the recorder's — from any Convex client, or by editing the value in the browser before the existing call.

### Native input and bounded instructions

Inputs:

- `markSegmentUploaded({ token, segmentId, durationSeconds: 60 }) for an answer whose provider-timed transcript spans 0-8.0 s under a 120 s limit`
- `markSegmentUploaded({ token, segmentId, durationSeconds: 48 }) for a 100-word answer actually recorded over the full 120 s`
- `markSegmentUploaded({ token, segmentId, durationSeconds: 1 }) to clamp every chooseStartSeconds result to 0 while anchored stays true`

Instructions:

1. Wrote /root/security-audit-skill/interw/run-1/agents/verifier-v03/scratch/recheck.mjs, importing computeParaverbal from /home/user/interw/convex/lib/paraverbal.ts and chooseStartSeconds + resolveQuoteStart from /home/user/interw/convex/lib/evidence.ts (both dependency-free, unmodified repository files) and evaluating the payloads above on two fixtures plus the non-finite variant and the anchor clamp.
2. Ran it through the parent sandbox wrapper: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v03 'node --experimental-strip-types ./recheck.mjs > ./recheck.txt 2>&1' — new mount+network namespace with no interfaces, env -i, target and /root read-only, scratch-only writes, prlimit --cpu=20 --fsize=8388608 --nofile=256 --nproc=64, 60 s wall clock. No network, no deployment, no provider call, dummy data only.
3. Compared the six dimension scores across durations for one unchanged transcript, and the anchor offset of a second-chunk quote across durations 8, 5, 1, 0 and null.
4. The confirmed observed_result below is taken from scratch/recheck.txt produced by that run (harness: scratch/recheck.mjs); both are regular files directly under the verifier scratch root and are the files to promote if this record's reproduction is retained as evidence.
5. Cross-checked against the two hunter artifacts (agents/hunter-w1-h09/artifacts/paraverbal-duration.txt and agents/hunter-w1-h02/artifacts/local-checks.log); the h09 numbers reproduce exactly, and the h02 direction reproduces on an equivalent 100-word fixture.

### Observed output and invariant proved

Same transcript (chunks 0-3.9 s and 4.1-8.0 s, maxResponseSeconds 120), only the client number changed: durationSeconds 8 -> pace 10 (142.5 wpm), concision 0.5 (6.7%), engagement 1.4 (8 s); 60 -> pace 0 (19 wpm), concision 10 (50%), engagement 10 (60 s); 100 -> concision 10 (83.3%), engagement 10 (100 s). Second fixture (100 words genuinely spread over 120 s): claiming 120 s gives pace 0 (50 wpm), concision 2.5, pauses 9.7; claiming 48 s gives pace 10 (125 wpm), concision 10, pauses 4.2. Anchors for the quote 'cut the release cycle from two weeks', whose transcript-resolved start is 4.1 s: durationSeconds 8 -> 4.1; 5 -> 4; 1 -> 0; 0 or null -> 4.1 (unclamped). Non-finite variant (acceptance over the Convex wire not verified here, and not relied on): NaN -> computeParaverbal returns null, suppressing the whole Delivery section; Infinity -> pace 0, concision 0, engagement 0, consistency NaN. Exit 0; recorded in scratch/recheck.txt.

### Remediation and regression

Stop using the client's number as the measurement. Persist a server-observed length on the segment when the transcription returns — the provider's usage.total_seconds, already available as result.audioSeconds at convex/pipeline.ts:283, with the last transcript chunk end as a fallback — and have reportInputs feed that value to computeParaverbal, chooseStartSeconds and the highlight clamp; when no server-observed length exists, pass null so the answer is honestly excluded from the para-verbal aggregate and its quotes are left unclamped rather than clamped by a number the candidate chose. Keep the client value only as a UI/telemetry hint, and independently harden the write: reject a non-finite durationSeconds at markSegmentUploaded and clamp it to [0, question.maxResponseSeconds + small margin] so no stored value can exceed what the recorder could have produced. This enforces the invariant rather than moving trust, because both replacements are quantities the server obtained itself. Add regression tests in convex/lib/paraverbal.test.ts and convex/pipeline.test.ts asserting that para-verbal scores, highlight bounds and anchor offsets for a fixed transcript are unchanged when the segment's client-reported duration varies (8 vs 60 vs 1), and note the rule in CLAUDE.md alongside the existing "an authorisation never depends on an argument" family: a measurement presented to a recruiter never depends on an argument either.

`convex/pipeline.ts`:

```ts
// transcribeSegment: keep the length the provider measured, next to the transcript.
await ctx.runMutation(internal.pipeline.saveTranscript, {
  segmentId,
  text: result.text,
  words: result.words,
  model: result.model,
  audioSeconds: result.audioSeconds ?? undefined,
})

// saveTranscript: args gain `audioSeconds: v.optional(v.number())`, and the
// measured length is written onto the segment (schema: segments.measuredSeconds,
// v.optional(v.number())) so the report never has to ask the client.
const measured =
  audioSeconds !== undefined && Number.isFinite(audioSeconds) && audioSeconds > 0
    ? audioSeconds
    : words.reduce((max, word) => Math.max(max, word.end), 0)
if (measured > 0) {
  await ctx.db.patch('segments', segmentId, { measuredSeconds: measured })
}

// reportInputs: the answer length is what the server observed, or nothing.
// `segment.durationSeconds` is a client hint and is deliberately not read here.
return {
  segmentId: segment._id,
  questionId: segment.questionId,
  questionIndex: segment.questionIndex,
  durationSeconds: segment.measuredSeconds ?? null,
  maxResponseSeconds: question?.maxResponseSeconds ?? 120,
  question: question?.content ?? '',
  text: transcript?.text ?? '',
  chunks: transcript?.words ?? [],
}
```

`convex/interview.ts`:

```ts
// markSegmentUploaded: the client number survives only as a hint, and only
// within what the recorder could physically have produced.
if (!Number.isFinite(durationSeconds)) throw new ConvexError('invalid_duration')
const question = await ctx.db.get('questions', segment.questionId)
const cap = (question?.maxResponseSeconds ?? 120) + 5
await ctx.db.patch('segments', segmentId, {
  uploadState: 'uploaded',
  durationSeconds: Math.min(cap, Math.max(0, Math.round(durationSeconds))),
})
```

## LOW — files.setMyAvatar attaches any _storage id without binding it to the caller, so a plain member deletes the organisation logo — an admin-only asset — through the avatar path

Fingerprint: `convex/files.ts:setMyAvatar:storageId-unbound-to-caller`

files.setMyAvatar takes a storageId straight from the client and validates only that the blob exists, is at most 20 MB and has an allowed image content type; nothing checks that the caller uploaded it or that another row already owns it. The id is written to the caller's users.avatarStorageId, and the caller's next removeMyAvatar (or a second successful setMyAvatar) calls ctx.storage.delete on it. organizations.bySlug spreads the whole organisation row to every member, logoStorageId included, and every page under /app/$orgSlug loads that query, so a plain member already holds the logo's storage id. Calling setMyAvatar with it and then removeMyAvatar deletes the organisation's logo blob even though setOrgLogo and removeOrgLogo are admin-only; the organisation row keeps a dangling logoStorageId and resolveLogoUrl then returns null for every member on every page. The same primitive reaches any _storage id the caller learns — a colleague's avatar id would do — but the app's other queries expose only resolved avatarUrl values, so the organisation logo is the case reachable from data the member is given.

**Root cause.** convex/files.ts:40-54 (setMyAvatar) and 56-69 (removeMyAvatar), together with validateImage at convex/files.ts:16-30, treat a client-supplied Id<'_storage'> as owned by the caller: validateImage reads _storage metadata for any id (line 20) and never compares it to the caller, setMyAvatar stores it after requireAppUser only (lines 43-49), and the later delete (line 61, or line 46 on the next attach) runs on whatever id was stored. Convex file storage has no per-file owner — the _storage system table carries only _id, _creationTime, contentType, sha256 and size (convex/_generated/ai/guidelines.md file-storage section) — and convex/organizations.ts:126 puts the logo's id in every member's hands by spreading the organisations row.

**Intended behaviour.** Only an organisation's admins or owner may change or remove its logo (convex/files.ts:74 and 91 both call requireOrgRole(ctx, orgId, 'admin')), and a user's avatar operations should be able to attach and delete only blobs that user attached themselves — never one that another users or organizations row references.

### Trace

1. **entrypoint** `convex/organizations.ts:126` — organizations.bySlug return value: The whole organisation row is spread to any member, logoStorageId included; every page under /app/$orgSlug calls this query (for example src/routes/app/$orgSlug/projects.$projectSlug.index.tsx:41), so the member already holds the raw storage id.
2. **propagation** `convex/files.ts:43` — files.setMyAvatar handler: The member calls setMyAvatar with the logo's storage id; the only guard is requireAppUser — any registered user passes it.
3. **propagation** `convex/files.ts:20` — validateImage: The blob's _storage metadata is read for existence, size and content type; an organisation logo is an image under 20 MB, so it passes. Ownership is never considered.
4. **propagation** `convex/files.ts:48` — files.setMyAvatar handler: The foreign id is written to the caller's own users.avatarStorageId, which is what makes it the caller's to delete.
5. **propagation** `convex/files.ts:61` — files.removeMyAvatar handler: ctx.storage.delete(user.avatarStorageId) runs on the organisation's logo blob; Convex storage has no per-file ownership to refuse it.
6. **sink** `convex/lib/storage.ts:23` — resolveLogoUrl: ctx.storage.getUrl(org.logoStorageId) now returns null and the organisation row still points at the deleted blob, so the logo is gone for every member on every page while only an admin was ever allowed to remove it.

### Evidence

- `convex/files.ts:74` — setOrgLogo calls requireOrgRole(ctx, orgId, 'admin') — logo management is intended to be admin-only.
- `convex/files.ts:91` — removeOrgLogo is likewise admin-only, and its body is the same ctx.storage.delete the avatar path reaches without a role check.
- `convex/files.ts:21` — validateImage's only rejection for an unknown blob is not_found; for a blob that exists it checks size and contentType and returns, so any existing image id of the deployment is accepted.
- `convex/files.ts:46` — A second successful setMyAvatar also deletes the previously stored id, so the primitive can be repeated without ever calling removeMyAvatar.
- `convex/schema.ts:265` — organizations.logoStorageId is a plain optional Id<'_storage'> field of the organisations row — the row bySlug spreads.
- `convex/organizations.ts:126` — bySlug returns `...org`, so logoStorageId reaches every member's client; by contrast users.me (convex/users.ts:59) and organizations.listMembers (convex/organizations.ts:31) expose only a resolved avatarUrl, never an avatar storage id.
- `convex/users.ts:181` — cascadeDelete calls ctx.storage.delete on a blob attached in an earlier session, and removeOrgLogo does the same for a logo uploaded by a different admin: the application itself depends on ctx.storage.delete accepting any id, which is why no ownership check exists to stop this one.

### Principal and resource

A member opens any page of their organisation, reads org.logoStorageId out of the bySlug result already sitting in their client cache, and calls two public avatar mutations from the browser console; from the product's point of view they simply changed and then removed their profile picture.

### Conditions and containment

- **authentication_level**: Registered, authenticated user provisioned in the Convex users table.
- **authorization_role**: Plain member of the organisation — enough to read logoStorageId through bySlug, and exactly the tier that setOrgLogo/removeOrgLogo refuse with insufficient_role.
- **data_state**: The organisation has a logo stored in Convex storage (logoStorageId set); the caller's own avatar may be set or unset, the sequence works either way.
- **third_party_dependency**: Relies on Convex file storage having no per-file ownership, so ctx.storage.delete removes any existing _storage id. That is the documented API shape (the _storage system table carries no owner field) and the app's own admin flows depend on it, but the deletion itself was modelled by a fake ctx.storage in the local run, not observed against a live Convex deployment.

### Native input and bounded instructions

Inputs:

- `api.organizations.bySlug { slug: <org slug> } -> read logoStorageId from the result`
- `api.files.setMyAvatar { storageId: <that logoStorageId> }`
- `api.files.removeMyAvatar {}`

Instructions:

1. Verifier re-check, independent of the hunter's harness (no deployment, no network, no dependency installation). From /root/security-audit-skill/interw/run-1/agents/verifier-v05/scratch, run: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v05 'node --experimental-strip-types --import ./vtmp/register.mjs ./verify-harness.mjs' (new mount+net namespace with no interfaces, read-only target, env -i, prlimit cpu=20 fsize=8MiB nofile=256 nproc=64, 60 s wall clock).
2. verify-harness.mjs imports the real convex/files.ts, convex/organizations.ts and convex/lib/{auth,storage}.ts with only convex/values, convex/server, convex/_generated/*, convex/auth.ts, convex/email.ts and convex/emailTemplates.ts stubbed, seeds a dummy org whose logoStorageId points at a fake _storage entry (image/png, 2048 bytes) plus a separate owner-avatar blob, and calls the handlers as a plain member against a fake ctx.storage that records every delete and returns null from getUrl once a blob is gone — the documented Convex behaviour, modelled rather than observed.
3. Read section V3 of scratch/verify-harness.log (promote this file as evidence: it is the file the confirmed observed_result below is taken from).

### Observed output and invariant proved

V3.1/V3.2 organizations.bySlug called as the plain member returns a payload whose keys include logoStorageId, value 'logo_blob_a'. V3.3 member setOrgLogo -> {ok:false, error:'insufficient_role'} and V3.4 member removeOrgLogo -> {ok:false, error:'insufficient_role'}. V3.5 the logo resolves to a URL. V3.6 member setMyAvatar({storageId:'logo_blob_a'}) -> {ok:true}; V3.7 the member's users row now carries the organisation's logo id. V3.8 member removeMyAvatar() -> {ok:true}; V3.9 storage.delete was called exactly once, with 'logo_blob_a'; V3.10 org.logoStorageId still points at it; V3.11 resolveLogoUrl now returns null for that member. V3.12/V3.13 the same member also attaches another user's avatar id successfully, which is the general form of the primitive. V3.14 setMyAvatar with an id that does not exist -> {ok:false, error:'not_found'}, so validateImage runs before the delete of the previously attached blob.

### Remediation and regression

Bind the blob to the caller instead of trusting the id: refuse to attach a storageId that any other users.avatarStorageId or organizations.logoStorageId row already references, and delete a blob only when the row being cleared is the reference being removed. Add the two indexes the check needs, and stop spreading the organisations row in bySlug so raw storage ids never reach a client that is not allowed to manage the blob — the resolved logoUrl is all the UI uses.

`convex/schema.ts`:

```ts
// users: add the index the ownership check reads
//   .index('by_avatarStorageId', ['avatarStorageId'])
// organizations: same
//   .index('by_logoStorageId', ['logoStorageId'])
```

`convex/files.ts`:

```ts
/**
 * A blob may be attached only if no other row already owns it. Convex
 * storage has no per-file owner, so the reference in our own tables is the
 * only ownership record there is — and the delete that follows an attach is
 * what makes an unchecked id dangerous.
 */
async function assertUnclaimed(
  ctx: GenericMutationCtx<DataModel>,
  storageId: Id<'_storage'>,
  self: { table: 'users'; id: Id<'users'> } | { table: 'organizations'; id: Id<'organizations'> },
): Promise<void> {
  const owner = await ctx.db
    .query('users')
    .withIndex('by_avatarStorageId', (q) => q.eq('avatarStorageId', storageId))
    .first()
  if (owner && !(self.table === 'users' && owner._id === self.id)) {
    throw new ConvexError('not_found')
  }
  const org = await ctx.db
    .query('organizations')
    .withIndex('by_logoStorageId', (q) => q.eq('logoStorageId', storageId))
    .first()
  if (org && !(self.table === 'organizations' && org._id === self.id)) {
    throw new ConvexError('not_found')
  }
}

export const setMyAvatar = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    const user = await requireAppUser(ctx)
    await validateImage(ctx, storageId)
    await assertUnclaimed(ctx, storageId, { table: 'users', id: user._id })
    if (user.avatarStorageId && user.avatarStorageId !== storageId) {
      await ctx.storage.delete(user.avatarStorageId)
    }
    await ctx.db.patch('users', user._id, {
      avatarStorageId: storageId,
      avatarUrl: undefined,
    })
    return null
  },
})

// setOrgLogo: after requireOrgRole and validateImage, add
//   await assertUnclaimed(ctx, storageId, { table: 'organizations', id: orgId })
```

`convex/organizations.ts`:

```ts
    // Return the fields the app uses, never the raw storage id: a member who
    // holds `logoStorageId` holds a handle the avatar path would delete.
    return {
      _id: org._id,
      _creationTime: org._creationTime,
      slug: org.slug,
      name: org.name,
      createdBy: org.createdBy,
      createdAt: org.createdAt,
      logoUrl: await resolveLogoUrl(ctx, org),
    }
```

## LOW — markSegmentFailed and start write sessionEvents rows without the per-session cap that logEvent applies

Fingerprint: `convex/interview.ts:markSegmentFailed:sessionEvents-uncapped`

convex/interview.ts caps sessionEvents per session at MAX_SESSION_EVENTS, and the comment above the trim says why: the endpoint is public, gated only by the token, and the rate limiter still admits 120 writes a minute, so the size of this table for one session would otherwise be chosen by whoever holds the link. The trim lives inside the logEvent handler rather than at the table's insertion point, and two sibling writers of the same table skip it: markSegmentFailed inserts one 'upload_failed' row carrying up to 500 characters of caller-supplied detail on every call and can be re-invoked on the same segment indefinitely, and start on an already in_progress session inserts one 'interview_resumed' row per call. A link holder with an open session can therefore add rows to the shared sessionEvents table at the limiter's rate — on the order of 172,800 rows a day per token — with no trim at any point. Nothing on the recruiter side reads the table; the rows are removed only when the session is erased, and erasure spends them 100 per scheduled pass (purge.ts DELETE_BATCH), so the cost lands on storage and on the number of erasure passes rather than on any request path. A separate, non-security defect was observed while verifying: logEvent's own trim uses existing.slice(0, existing.length - MAX_SESSION_EVENTS), whose negative second argument makes slice count from the end, so the cap settles around 100 rows instead of 200.

**Root cause.** The per-session bound on sessionEvents is implemented inside one handler (logEvent, convex/interview.ts:455-461) instead of in a shared helper at the table's insertion point, so writers added elsewhere in the same module — markSegmentFailed (425) and start (148) — insert into the same table with no bound.

**Intended behaviour.** As the logEvent comment states, no token holder should choose the size of sessionEvents for their session: every writer of the table honours MAX_SESSION_EVENTS, keeping the most recent rows and dropping the rest.

### Trace

1. **entrypoint** `convex/interview.ts:413` — markSegmentFailed (public mutation, args { token, segmentId, detail }): Public, token-authenticated mutation; detail is an unbounded caller-supplied string at the interface.
2. **propagation** `convex/interview.ts:417` — markSegmentFailed handler: requireOpenSession: the attacker needs a link whose session is still open (consent given, role live) — an ordinary mid-interview state.
3. **propagation** `convex/interview.ts:418` — markSegmentFailed handler, consumeLimit: The only bound on call frequency: the per-token candidateWrite bucket, 120 per minute.
4. **propagation** `convex/interview.ts:421` — markSegmentFailed handler: The segment need only belong to the resolved session; nothing prevents calling it repeatedly on the same already-failed segment.
5. **sink** `convex/interview.ts:425` — markSegmentFailed handler, ctx.db.insert('sessionEvents'): Unconditional insert with detail.slice(0, 500) and no take/trim of existing rows — the cap that logEvent applies is absent here.

### Evidence

- `convex/interview.ts:40` — MAX_SESSION_EVENTS = 200, documented as 'Newest events kept per session. See logEvent.'
- `convex/interview.ts:452` — The comment stating the reason for the cap: the endpoint is public, the limiter still allows 120 writes a minute, so the size of this table for one session was chosen by whoever held the link.
- `convex/interview.ts:455` — The trim (take(MAX_SESSION_EVENTS + 1) then delete the excess) exists only inside logEvent.
- `convex/interview.ts:459` — existing.slice(0, existing.length - MAX_SESSION_EVENTS): with fewer than MAX+1 rows the second argument is negative, so slice counts from the end and the steady-state cap is about 100 rows rather than 200.
- `convex/interview.ts:148` — The second uncapped writer: start on a session that is not 'pending' inserts one 'interview_resumed' row per call, also behind requireOpenSession and the same 120/min bucket.
- `convex/rateLimiters.ts:49` — candidateWrite: token bucket, rate 120 per minute, capacity 30, keyed by the resolved token — the only ceiling on how fast these rows can be created.
- `convex/schema.ts:622` — sessionEvents is defined with no size bound and only a by_session index; detail is an optional free-form string.
- `convex/purge.ts:87` — Comment: a session's row count is not bounded by anything the product controls because sessionEvents is written by the candidate's own browser — the reason erasure had to be batched at all.
- `convex/purge.ts:93` — DELETE_BATCH = 100: deleteSessionRecords removes at most 100 child rows per scheduled pass and reschedules itself, so each extra 100 rows costs one more pass of the erasure path.
- `convex/candidate.ts:138` — The fourth writer, acceptConsent, inserts one row and is naturally once-per-session (it returns early once consentAcceptedAt is set), so it is not part of the unbounded set.

### Principal and resource

A link holder loops markSegmentFailed on one of their own reserved segments (or start on their in_progress session) at the rate limiter's ceiling. Every call persists a sessionEvents row — up to 500 characters of attacker-chosen detail for markSegmentFailed — that no cap removes, until the whole session is erased.

### Conditions and containment

- **authentication_level**: Holder of a candidate session access token with an open session (consent accepted, role live, session not terminal); no account. For markSegmentFailed, one reserved segment of that session is also needed, which reserveSegment provides.
- **user_interaction**: Deliberate scripted repetition of a mutation the honest client calls only on an actual upload failure or an actual resume.

### Native input and bounded instructions

Inputs:

- `400 x api.interview.markSegmentFailed({ token, segmentId, detail: 'y'.repeat(2000) })`
- `400 x api.interview.start({ token }) on a session whose status is 'in_progress'`
- `400 x api.interview.logEvent({ token, kind: 'network_drop', detail: 'x'.repeat(500) }) as the capped control`

Instructions:

1. Bounded local check only; no deployment, endpoint or external service was contacted. From the verifier scratch directory run: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v01 'node --experimental-strip-types --import ./register.mjs ./harness.ts'.
2. harness.ts imports the UNMODIFIED /home/user/interw/convex/interview.ts through loader hooks that substitute inert stubs for convex/values, convex/server, convex/_generated/*, @convex-dev/* (including a permissive rate limiter that always admits, so the handlers themselves are what is under test) and zod; ctx.mjs is an in-memory ctx.db.
3. Check D seeds a dummy org/project/question/session in status 'in_progress' with consent and one reserved segment, then runs 400 logEvent calls, 400 markSegmentFailed calls on that one segment and 400 start calls, printing ctx.db.count('sessionEvents') after each phase, the longest stored detail and the distinct kinds.
4. Check E prints every ctx.db.insert('sessionEvents') / ctx.db.delete('sessionEvents') site in convex/interview.ts by line, to show which writers trim.
5. This record's observed_result is taken from the promoted scratch file verify.log, written by that sandbox run.
6. Owner regression (not run here; node_modules is absent and installation is prohibited): a convex-test case asserting that after N calls of each of logEvent, markSegmentFailed and start, the sessionEvents count for the session never exceeds MAX_SESSION_EVENTS.

### Observed output and invariant proved

After 400 logEvent calls: sessionEvents = 100 rows (the trim runs, and settles at ~100 rather than 200 because of the negative slice bound at interview.ts:459). After a further 400 markSegmentFailed calls on the same segment: 500 rows — all 400 retained, no trim. After a further 400 start calls on the in_progress session: 900 rows — all 400 retained, no trim. Longest stored detail = 500 characters (the slice(0, 500) at interview.ts:429). Kinds present: network_drop, upload_failed, interview_resumed. Check E shows inserts at interview.ts:148, 425 and 463 with the only delete at 460, inside logEvent.

### Remediation and regression

Move the trim out of logEvent into one appendSessionEvent helper and route every writer of the table through it (logEvent, markSegmentFailed, start, and acceptConsent in convex/candidate.ts), so the bound lives at the insertion point rather than in one handler. Fix the arithmetic at the same time — Math.max(0, existing.length - MAX_SESSION_EVENTS) — so the cap actually keeps the most recent MAX_SESSION_EVENTS rows instead of settling near half that. Add a convex-test asserting the per-session count never exceeds MAX_SESSION_EVENTS after repeated calls of each writer.

`convex/interview.ts`:

```ts
/**
 * The one way a sessionEvents row is written. The cap belongs here, at the
 * insertion point, and not in one handler: this table is fed by public
 * token-gated mutations, so its size per session must never be the caller's
 * choice.
 */
async function appendSessionEvent(
  ctx: GenericMutationCtx<DataModel>,
  session: Doc<'sessions'>,
  event: { kind: SessionEventKind; detail?: string; at: number },
): Promise<void> {
  const existing = await ctx.db
    .query('sessionEvents')
    .withIndex('by_session', (q) => q.eq('sessionId', session._id))
    .take(MAX_SESSION_EVENTS + 1)
  const excess = Math.max(0, existing.length - MAX_SESSION_EVENTS)
  for (const stale of existing.slice(0, excess)) {
    await ctx.db.delete('sessionEvents', stale._id)
  }
  await ctx.db.insert('sessionEvents', {
    orgId: session.orgId,
    sessionId: session._id,
    kind: event.kind,
    detail: event.detail?.slice(0, 500),
    at: event.at,
  })
}

// start (the resume branch), markSegmentFailed, logEvent and
// candidate.acceptConsent all call appendSessionEvent instead of inserting
// into 'sessionEvents' directly.
```

## LOW — Re-reserving an answer with a different container, or without video, drops the earlier recording's key from the row, so no erasure path ever deletes it

Fingerprint: `convex/interview.ts:reserveSegment:replaced-keys-orphaned`

The candidate surface documents the reason erasure is exact: the `segments` row is written before the upload, carrying the keys, so "every object this candidate ever created is named in the database, even the ones whose upload then failed" (convex/interview.ts:232-235). That invariant holds only while the key is stable, and it is not: `segmentKey` embeds an extension derived from the declared MIME type (convex/lib/objectStore.ts:238, 271-291), and the video slot is optional. `reserveSegment` handles a repeat reservation of the same question by patching the existing row in place with the newly derived keys (convex/interview.ts:304-309); it never reads `existing.audioKey`/`existing.videoKey`, never deletes the objects they name, and keeps no record of them. Three audio containers (audio/webm -> q0.weba, audio/mp4 -> q0.m4a, audio/mpeg -> q0.mp3) and two video containers (video/webm -> q0.webm, video/mp4 -> q0.mp4) are accepted (convex/interview.ts:41-42), so a second reservation that differs in container, or that omits the video part, points the row at different keys. Every erasure path — the candidate's own `deleteMyData` (convex/candidate.ts:386-399), the recruiter's `deleteCandidateData` (convex/sessions.ts:345-355) and the twelve-month retention cron (convex/retention.ts:33-45) — builds its delete list from `purge.collectSessionObjects`, which enumerates only the keys currently on the rows (convex/purge.ts:64-72). Nothing in the repository lists the bucket by prefix. An object already PUT under the superseded key therefore stays in the private bucket after the candidate exercises their right to erasure, after the recruiter deletes the candidate, and after the retention purge, while `purgeLog` records `objectsDeleted` as the count of keys that were on the rows (convex/purge.ts:200-207) and the UI tells the candidate "Nothing from this interview is held any more" (src/locales/en/interview.json:170). The codebase already names this exact hazard and handles it everywhere else an object can be replaced: `attachDocument` deletes the document key it replaced (convex/candidate.ts:327), and the recruiter media path says so outright — "Re-recording a question in a different container changes the extension, so without this the bucket accumulates every take" (convex/media.ts:207-211).

**Root cause.** `reserveSegment` replaces `audioKey`/`videoKey` on an existing `segments` row (convex/interview.ts:304-309) without deleting the objects the previous keys name and without retaining those keys anywhere, while every erasure and retention path derives its object set exclusively from the keys currently on the rows (convex/purge.ts:64-72). The key is a function of the declared container extension and of whether a video part is present, so a second reservation that differs in either yields keys that no longer name the objects already written.

**Intended behaviour.** convex/interview.ts:229-238 states the contract: the segment row is written before the upload so that every object the candidate ever caused to be written is named in the database and "delete everything about this person" never has to guess or scan; convex/purge.ts:1-11 and 50 restate it ("Every object this session ever caused to be written"). CLAUDE.md's Erasure rules say the same and add that objects are deleted before rows. The sibling replacement paths show the intended handling: convex/candidate.ts:307-312 returns the replaced key and convex/candidate.ts:327 deletes it; convex/media.ts:207-234 does the same for recruiter media, with a comment naming the container-change case explicitly.

### Trace

1. **entrypoint** `convex/interview.ts:330` — requestSegmentUpload (public action, session-token authenticated): Candidate submits {token, questionIndex, audio:{mimeType,contentLength}, video?}; the same question may be submitted again, with different MIME types or with the video part omitted. It delegates to reserveSegment and returns presigned PUT URLs for the derived keys.
2. **propagation** `convex/interview.ts:271` — reserveSegment: audioKey = segmentKey(orgId, sessionId, questionIndex, extension) where the extension comes from the newly declared MIME type, so a different accepted audio container yields a different key for the same answer slot.
3. **propagation** `convex/interview.ts:288` — reserveSegment: videoKey = videoSlot?.key, i.e. undefined whenever this reservation carries no video part, even if an earlier reservation of the same slot did.
4. **propagation** `convex/interview.ts:306` — reserveSegment, existing-row branch: The existing segments row is patched with the new audioKey/videoKey and uploadState 'pending'. existing.audioKey and existing.videoKey are never read, deleteObjects is never called, and no field on the row records the keys that were just replaced.
5. **propagation** `convex/purge.ts:64` — collectSessionObjects: The complete object set for a session is built from segment.videoKey/audioKey/thumbnailKey plus session.cvKey/coverLetterKey. A key that is no longer on a row is not in the set, and no code path lists the bucket by prefix to find it.
6. **sink** `convex/candidate.ts:393` — deleteMyData (public action, candidate-initiated erasure): deleteObjects(objects.keys) deletes exactly the collected keys, then deleteSessionRecords writes purgeLog with objectsDeleted = keys.length. The superseded object is not in that list, survives in the private bucket, and is now unreachable from the database entirely. convex/sessions.ts:349 (recruiter deletion) and convex/retention.ts:40 (twelve-month cron) reach the same sink with the same set.

### Evidence

- `convex/interview.ts:233` — The stated invariant this breaks: "every object this candidate ever created is named in the database, even the ones whose upload then failed, so 'delete everything about this person' never has to guess or scan".
- `convex/interview.ts:41` — ALLOWED_VIDEO_TYPES ['video/webm','video/mp4'] and (line 42) ALLOWED_AUDIO_TYPES ['audio/webm','audio/mp4','audio/mpeg']: three audio containers and two video containers are accepted for the same slot.
- `convex/lib/objectStore.ts:238` — segmentKey returns `orgs/{orgId}/sessions/{sessionId}/q{index}.{extension}` — the key varies with the extension alone.
- `convex/lib/objectStore.ts:271` — extensionForMimeType maps each accepted container to a distinct extension (video/webm->webm, video/mp4->mp4, audio/webm->weba, audio/mp4->m4a, audio/mpeg->mp3), so the five accepted answer MIME types produce five distinct keys for one question.
- `convex/schema.ts:456` — The segments table carries only videoKey/audioKey/thumbnailKey — there is no field in which a replaced key could be retained.
- `convex/lib/objectStore.ts:190` — deleteObjects deletes exactly the keys it is handed; the module exposes no bucket LIST operation, so an unnamed object cannot be found again.
- `convex/media.ts:209` — The codebase names this exact hazard in the recruiter media path: "Re-recording a question in a different container changes the extension, so without this the bucket accumulates every take" — and handles it there (media.ts:216, 232) but not in the candidate segment path.
- `convex/candidate.ts:327` — attachDocument deletes the object the candidate's document key replaced, the sibling pattern the segment path lacks.
- `convex/retention.ts:40` — The twelve-month retention cron deletes exactly collectSessionObjects' keys, so the orphan also survives the automatic purge.
- `convex/sessions.ts:349` — The recruiter's deleteCandidateData deletes exactly the same collected set, so all three erasure paths share the gap.
- `convex/purge.ts:200` — purgeLog is written with objectsDeleted = the number of keys found on the rows, so the register attests to a complete erasure that left an object behind.
- `src/locales/en/interview.json:170` — What the candidate is told after erasure: "Nothing from this interview is held any more." (line 165 promises recordings, transcript, analysis and documents are permanently deleted).

### Principal and resource

The affected principal is the data subject, not an attacker: a candidate whose first upload landed but whose completion call did not, who re-records that answer from another browser, and who later presses "Delete everything". They are told nothing from the interview is held any more, while a recording of their own face and voice remains in the recruiter organisation's private bucket, named nowhere in the database and therefore unreachable by any application code path — including the recruiter's own deletion and the twelve-month retention purge. A link holder can also produce such an object deliberately, leaving the organisation holding candidate media it has no means to enumerate or erase.

### Conditions and containment

- **authentication_level**: Holder of a candidate session access token (the data subject); no account. The session gate must be ready or resumable and consent given (convex/interview.ts:63-77).
- **data_state**: A PUT already landed in the bucket for question N under the keys of a first reservation, and question N is reserved again before finish with a different accepted audio container, or without the video part after a video part was written.
- **user_interaction**: Through the product this is a resume or retry after the upload succeeded but markSegmentUploaded did not: src/routes/s/$token/interview.tsx:156 re-records any question not marked answered, and a second browser or device (Chromium webm vs Safari mp4, or a device with no camera) reports a different container. A token holder can also reach it directly by calling requestSegmentUpload twice.
- **environmental_dependency**: No bucket-side lifecycle or expiry rule is configured or referenced anywhere in the repository; the product's erasure contract is immediate application-driven deletion, which such a rule would not satisfy in any case.

### Native input and bounded instructions

Inputs:

- `requestSegmentUpload({ token, questionIndex: 0, audio: { mimeType: 'audio/webm;codecs=opus', contentLength: 1024 }, video: { mimeType: 'video/webm', contentLength: 4096 } })  -> PUT both presigned URLs`
- `requestSegmentUpload({ token, questionIndex: 0, audio: { mimeType: 'audio/mpeg', contentLength: 2048 } })  -> same segment row, audioKey now q0.mp3, videoKey removed`
- `segmentKey('org_dummy','sess_dummy',0, extensionForMimeType(m)) for m in ['audio/webm;codecs=opus','audio/mp4','audio/mpeg','video/webm','video/mp4']`

Instructions:

1. Independent reproduction run through the parent sandbox wrapper: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v02 'node --experimental-strip-types --import ./register.mjs ./verify-orphan.ts', from the verifier-v02 scratch directory. Output retained as the scratch file verify-orphan.log (please promote it; the observed_result below is that file's content).
2. The harness loads the UNMODIFIED repository modules convex/interview.ts, convex/purge.ts and convex/lib/objectStore.ts through a resolve hook that only substitutes convex/values, convex/server, convex/_generated/* and @convex-dev/rate-limiter, and supplies an in-memory ctx.db implementing Convex patch semantics (a field patched with an explicit undefined is removed from the document). Fixtures are dummy rows only: one org, one active project, one question at orderIndex 0, one in-progress session with consent and a 43-character dummy token. No network, no provider calls, node_modules absent.
3. It calls the real reserveSegment handler for question 0 with audio/webm + video/webm, marks the row uploaded, snapshots the erasure set returned by the real purge.collectSessionObjects, then calls reserveSegment again for question 0 with audio/mpeg and no video, snapshots the erasure set again, and diffs the two. A third reservation with audio/mp4 + video/mp4 shows the previous pair dropped in turn. It then greps the target source to confirm reserveSegment neither reads the existing keys nor calls deleteObjects, that the segments schema has no field for a retired key, that neither purge.ts nor objectStore.ts contains any bucket LIST operation, and that candidate.attachDocument does delete the object it replaced.
4. The audio-container branch does not depend on the ctx stub's undefined-removal semantics: audioKey is patched to a different non-undefined string, so the earlier audio key is dropped from the erasure set under any patch semantics.
5. Owner-side regression to add (not run here, node_modules absent): in convex/erasure.test.ts reserve question 0 with audio/webm + video/webm, mark it uploaded, reserve question 0 again with audio/mp4, then run deleteMyData with deleteObjects spied (the file already spies it at line 286) and assert that q0.weba and q0.webm are among the keys passed to it.

### Observed output and invariant proved

Key derivation on the target's own functions: audio/webm;codecs=opus -> orgs/org_dummy/sessions/sess_dummy/q0.weba, audio/mp4 -> q0.m4a, audio/mpeg -> q0.mp3, video/webm -> q0.webm, video/mp4 -> q0.mp4. Reservation 1 (audio/webm + video/webm) -> audioKey .../q0.weba, videoKey .../q0.webm, uploadAttempts 1; erasure set BEFORE = [".../q0.webm", ".../q0.weba"]. Reservation 2 of the same question (audio/mpeg, no video) -> the SAME segment row (sameSegmentRow true, one row in the table), audioKey .../q0.mp3, videoKey undefined, uploadState pending, uploadAttempts 2; erasure set AFTER = [".../q0.mp3"]; DROPPED from the erasure set = [".../q0.webm", ".../q0.weba"]. Reservation 3 (audio/mp4 + video/mp4) -> erasure set [".../q0.mp4", ".../q0.m4a"], q0.mp3 still named: false. Source checks: reserveSegment reads existing.audioKey/videoKey: false; reserveSegment calls deleteObjects: false; segments schema has a superseded/retired key list: false; purge.ts mentions deleteObjects or a prefix listing: false; objectStore exports any bucket LIST operation: false; candidate.attachDocument deletes the replaced object: true. (verify-orphan.log)

### Remediation and regression

Restore the invariant that a segment row names every object its slot ever caused to be written. Two source-visible options, and the second is the one that matches the codebase's own ordering rule. (1) Mirror the sibling paths: have reserveSegment return the keys it replaced and have requestSegmentUpload delete them before handing back the new presigned URLs, exactly as candidate.attachDocument (candidate.ts:323-328) and media.attachIntroMedia/attachQuestionMedia (media.ts:212-234) already do. (2) Preferred, because it keeps 'row before upload' true and stays exact even if the delete call fails: add a superseded-key array to the segments row, append the replaced keys on every in-place re-reservation, and include it in purge.collectSessionObjects so all three erasure paths pick it up. Option 2 changes only additive schema and one enumeration, and it makes the register honest — objectsDeleted then counts every object that existed. Either way add the erasure regression described in the instructions, since the current suite never re-reserves with a different container. Note that the fix must not merely delete on re-reserve without also covering the window in which the delete itself fails; option 2 keeps the key named until the object is provably gone.

`convex/schema.ts`:

```ts
  segments: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    questionId: v.id('questions'),
    questionIndex: v.number(),
    videoKey: v.optional(v.string()),
    audioKey: v.optional(v.string()),
    thumbnailKey: v.optional(v.string()),
    /** Keys this slot was reserved under before and is no longer. An object
     *  once presigned stays named until erasure has deleted it: re-reserving
     *  the same answer with another container changes the extension, and the
     *  earlier object is otherwise named nowhere. */
    supersededKeys: v.optional(v.array(v.string())),
    durationSeconds: v.optional(v.number()),
    uploadState: uploadStateValidator,
    uploadAttempts: v.number(),
    transcriptionState: v.optional(transcriptionStateValidator),
    recordedAt: v.number(),
  })
    .index('by_session', ['sessionId', 'questionIndex'])
    .index('by_org', ['orgId']),
```

`convex/interview.ts`:

```ts
    let segmentId: Id<'segments'>
    if (existing) {
      segmentId = existing._id
      // The keys this slot is leaving behind. They may already name an object
      // in the bucket (the PUT can land even when markSegmentUploaded does
      // not), so they stay named on the row until erasure deletes them.
      const superseded = [existing.audioKey, existing.videoKey].filter(
        (key): key is string =>
          key !== undefined && key !== audioKey && key !== videoKey,
      )
      await ctx.db.patch('segments', existing._id, {
        ...fields,
        uploadAttempts: existing.uploadAttempts + 1,
        supersededKeys: [
          ...new Set([...(existing.supersededKeys ?? []), ...superseded]),
        ],
      })
    } else {
```

`convex/purge.ts`:

```ts
    const keys = [
      ...segments.flatMap((segment) =>
        [
          segment.videoKey,
          segment.audioKey,
          segment.thumbnailKey,
          ...(segment.supersededKeys ?? []),
        ].filter((key): key is string => key !== undefined),
      ),
      session.cvKey,
      session.coverLetterKey,
    ].filter((key): key is string => key !== undefined)
```

## LOW — Job-ad import runs quadratic tag-stripping regexes over the full 2 MiB fetched body before truncating, so one small hostile page burns a whole Node action lifetime of server CPU

Fingerprint: `convex/lib/htmlText.ts:htmlToText:quadratic-regex-over-uncapped-body`

importFromUrl (convex/jobImport.ts:60) fetches a recruiter-supplied URL through the Node action fetchJobPage, which accepts up to MAX_PAGE_BYTES = 2 MiB of decoded body (convex/jobImportFetch.ts:38, 84) with content type text/html, application/xhtml+xml or text/plain (line 39). The whole body is then handed to jobPostingText and htmlToText (convex/jobImport.ts:86-87). htmlToText assigns the body unsliced (convex/lib/htmlText.ts:63) and applies backtracking regexes to all of it: the per-dropped-element pair at lines 67 and 71, the block-tag pass at 76 and the generic strip /<[^>]+>/g at 77; the 12 000-character truncation is the last operation, at line 84. On input that is a run of tag openers with no '>' anywhere, [^>]* / [^>]+ consume to the end of the string at every start position and then backtrack, which is quadratic in the accepted size. I re-measured this in the parent sandbox on the unmodified module: the generic strip alone grows x4.00, x4.02, x4.01 per doubling (8 KiB to 64 KiB), i.e. textbook O(n^2), and accounts for essentially all of htmlToText's cost; htmlToText itself takes 1 707.8 ms at 64 KiB and 6 866.5 ms at 128 KiB, while a benign 2 MiB page of <p>...</p> prose takes 122.7 ms. Both doublings extrapolate to about 1 750 s (~29 minutes) of pure CPU at the 2 MiB the fetcher accepts. Any self-registered user who creates an organisation and a project (both open: convex/organizations.ts:74-106, convex/projects.ts:174-182) can point the wizard's 'Import from URL' at a static file of this shape, or hand the link to a recruiter; each request pins one Node action, at the operator's compute cost, until the platform kills it. The per-user limiter allows 5 immediately and then 20 per hour (convex/rateLimiters.ts:35), which bounds volume per account, not per deployment, and a new account brings a fresh quota.

**Root cause.** convex/lib/htmlText.ts bounds its output but not its work: htmlToText takes the body as-is (line 63) and applies character classes that can cross the whole remaining string ([^>]* at 67, 71, 76 and [^>]+ at 77) plus a lazy cross-tag scan ([\s\S]*? at 67), slicing to maxLength only at line 84; jobPostingText runs the same shape of matcher at 87-88 and re-enters htmlToText per JSON-LD field at 144. convex/jobImport.ts:86-87 feeds the complete 2 MiB body from readCapped into both with no parse budget, no incremental parser and no wall-clock guard around parsing.

**Intended behaviour.** The transfer cap exists precisely so that a page the recruiter did not author cannot consume the action's resources — the comment at convex/jobImportFetch.ts:37 states the cap is 'enough for any job ad' because 'htmlToText keeps 12 000 characters of it anyway', and jobImportFetch.ts:20-22 records that an earlier build was fixed because materialising the whole body 'took the action's memory with it'. Parsing an accepted body should therefore cost time linear in its size, so that the 2 MiB cap is a real bound on the work an import can cause.

### Trace

1. **entrypoint** `convex/jobImport.ts:60` — importFromUrl action: Public Convex action taking a caller-supplied `url` string (args at 61-66). It authorises through internal resolveImportContext -> requireProjectEditable (52-58) and consumes the per-user jobImport limiter (72) — both bound who may call and how often, neither bounds the work one call causes.
2. **propagation** `convex/jobImport.ts:76` — importFromUrl handler: Calls internal.jobImportFetch.fetchJobPage with the caller URL and binds the whole returned page to `html`.
3. **propagation** `convex/jobImportFetch.ts:156` — fetchJobPage: Returns `await readCapped(response)`, the decoded body, after readCapped stops pulling at MAX_PAGE_BYTES = 2 MiB (38, 84). This is the only size bound anywhere on the path, and it is a bound on bytes, not on parse work.
4. **propagation** `convex/jobImport.ts:86` — importFromUrl handler: jobPostingText(html) at 86 and htmlToText(html) at 87 are both invoked on the complete body; nothing between the fetch and these calls slices, streams or time-boxes it.
5. **sink** `convex/lib/htmlText.ts:77` — htmlToText: `.replace(/<[^>]+>/g, ' ')` — the dominant cost. On a run of '<' with no '>' the class consumes to end of input at every start position and then backtracks; measured in isolation at x4.00/x4.02/x4.01 per doubling and 1 722.6 ms at 64 KiB, against 1 707.8 ms for the whole of htmlToText on the same input. `.slice(0, maxLength)` at 84 runs only after this.

### Evidence

- `convex/lib/htmlText.ts:63` — `let text = html` — the body enters htmlToText unsliced; there is no parse budget at the function boundary.
- `convex/lib/htmlText.ts:67` — Per dropped element (script, style, noscript, template, svg, head, nav, footer, iframe — 9 passes): `<tag\b[^>]*>[\s\S]*?</tag\s*>`, an unbounded class followed by a lazy scan to the end of input for every unclosed opener.
- `convex/lib/htmlText.ts:71` — Second pass per dropped element: `<tag\b[^>]*/?>` — nine more unbounded `[^>]*` scans over the same body.
- `convex/lib/htmlText.ts:76` — Block-tag pass `<\/?(p|div|section|article|br|li|tr|h[1-6]|ul|ol|table)\b[^>]*>` — measured x3.81 per doubling on a body of `<p ` openers (929.0 ms at 64 KiB).
- `convex/lib/htmlText.ts:77` — Generic strip `<[^>]+>`; measured in isolation on '<'-only input at x4.00/x4.02/x4.01 per doubling, 1 722.6 ms at 64 KiB.
- `convex/lib/htmlText.ts:84` — `.slice(0, maxLength)` — the 12 000-character cap is the final operation, after every regex pass has already run over the full body.
- `convex/lib/htmlText.ts:88` — LD_JSON `<script\b[^>]*type=["\']application\/ld\+json["\'][^>]*>([\s\S]*?)<\/script\s*>` has the same shape; jobPostingText re-enters htmlToText per untruncated JSON-LD field at 144.
- `convex/jobImport.ts:87` — htmlToText(html) on the full body with the default 12 000 cap; no parse budget, no timeout, no incremental parser around it.
- `convex/jobImportFetch.ts:38` — MAX_PAGE_BYTES = 2 * 1024 * 1024 is the accepted input size, and the comment at 37 justifies it on the assumption that 'htmlToText keeps 12 000 characters of it anyway'.
- `convex/jobImportFetch.ts:39` — ALLOWED_CONTENT_TYPES includes 'text/plain', so the hostile body need not even look like a web page — a plain file of '<' characters is accepted and parsed.
- `convex/rateLimiters.ts:35` — jobImport limiter: `{ kind: 'token bucket', rate: 20, period: HOUR, capacity: 5 }`, keyed per user at convex/jobImport.ts:72 — bounds requests per account, not concurrent parse work per deployment. (The hunter cited line 475; the file is 83 lines long and the definition is at line 35.)
- `convex/organizations.ts:77` — `create` requires only requireAppUser, so any verified self-registered account can create an organisation and become its owner; convex/projects.ts:182 then requires only org membership to create the project the import needs.

### Principal and resource

A self-registered user creates an organisation and a project, hosts a static file whose body is a long run of unclosed tag openers, and imports it through the wizard's 'Import from URL' (src/components/projects/wizard/ImportFromUrlDialog.tsx). Each import holds one Node action busy in a synchronous regex until the platform kills it, at the operator's compute cost, and returns nothing useful to anyone. The same link handed to a recruiter produces the same effect with no attacker account. I did not touch any deployment: the pure, dependency-free parser was exercised offline in the parent sandbox with bounded inputs, and the cost at the accepted 2 MiB is an extrapolation of two independently consistent doublings.

### Conditions and containment

- **authentication_level**: Caller is a registered, email-verified user (email+password signup is enabled with requireEmailVerification, convex/auth.ts:103-105) who is a member of an organisation with a non-archived project they can see. Organisation and project creation are self-service, so a fresh account suffices.
- **network_routing**: The hostile page must be served from a public host that passes the lexical and DNS checks, answer 2xx with content type text/html, application/xhtml+xml or text/plain, and be at most 2 MiB after decompression. A static file on any ordinary web host meets this; it compresses to a few KiB on the wire.
- **data_state**: The payload must contain a long run of tag openers with no '>' — e.g. 2 MiB of '<', or of '<p '. A page with well-formed tags is parsed in linear time (benign 2 MiB prose measured at 122.7 ms).
- **environmental_dependency**: The per-request ceiling is the Convex Node action execution limit, and the deployment-wide effect depends on action concurrency and compute billing. Those are platform facts not visible in source and not observed here; they cap the damage per request rather than prevent it, since the extrapolated ~1 750 s of CPU exceeds any plausible action timeout.
- **user_interaction**: Alternatively no attacker account at all: a third party who gets a recruiter to paste such a link into the wizard causes the same work under the recruiter’s quota.

### Native input and bounded instructions

Inputs:

- `'<'.repeat(4096 | 8192 | 16384 | 32768 | 65536 | 131072) passed to htmlToText`
- `'<'.repeat(8192 | 16384 | 32768 | 65536) passed to the isolated /<[^>]+>/g strip from htmlText.ts:77`
- `'<p '.repeat(n).slice(0, 32768 | 65536) passed to htmlToText`
- `'<script>'.repeat(n).slice(0, 32768 | 65536) passed to htmlToText`
- `'<script type="application/ld+json">'.repeat(n).slice(0, 32768 | 65536) passed to jobPostingText`
- `'<p>Lorem ipsum dolor sit amet, consectetur adipiscing elit.</p>\n' repeated to exactly 2 MiB (benign control)`
- `'<p>Job &#1114112; ad</p>' and '<p>Job &#x110000; ad</p>' (incidental entity check)`

Instructions:

1. I wrote my own harness, scratch/verify-htmltext.mjs, independently of the hunter’s: it imports htmlToText and jobPostingText from /home/user/interw/convex/lib/htmlText.ts by absolute path, times each call with process.hrtime.bigint(), and prints the ratio against the previous (half-size) step so linear (x2) and quadratic (x4) are distinguishable.
2. Unlike the hunter I also timed the bare regex from htmlText.ts:77 (the bare `s.replace(/<[^>]+>/g, " ")` call) on the same inputs, to attribute the cost to a specific source line rather than to the function as a whole.
3. Phase A, run as: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v09 'node --experimental-strip-types <scratch>/verify-htmltext.mjs a <scratch>/htmltext-verify.log' — unshare -mn with no interfaces, repo and /root read-only, env -i, prlimit --cpu=20 --fsize=8388608 --nofile=256 --nproc=64, timeout 60 s. It covers the '<' curve to 64 KiB, the isolated-regex curve, and the benign 2 MiB control.
4. Phase B, run the same way with argument 'b': the 128 KiB step, the '<p ' / '<script>' / JSON-LD opener shapes, and the entity edge cases.
5. Extrapolate to the accepted cap from each of the two largest measured points independently (2 MiB / 64 KiB = 32, x1024; 2 MiB / 128 KiB = 16, x256) and check that the two extrapolations agree; no input larger than 128 KiB was ever run, so nothing approached the sandbox limits.
6. The full output of both phases is in the predeclared scratch file htmltext-verify.log (and the harness in verify-htmltext.mjs); the observed_result below is relied upon for this confirmation, so the parent should promote both.

### Observed output and invariant proved

Node v22.22.2 inside the sandbox. htmlToText on '<'.repeat(n): n=4096 -> 8.1 ms; 8192 -> 22.5 ms (x2.79); 16384 -> 95.0 ms (x4.22); 32768 -> 432.0 ms (x4.55); 65536 -> 1 707.8 ms (x3.95); 131072 -> 6 866.5 ms. The isolated generic strip /<[^>]+>/g on the same inputs: 26.7 / 106.8 / 429.7 / 1 722.6 ms, i.e. x4.00, x4.02, x4.01 — exactly quadratic, and it accounts for essentially the whole cost of htmlToText. Other shapes: '<p ' 32768 -> 244.1 ms, 65536 -> 929.0 ms (x3.81); '<script>' 32768 -> 22.5 ms, 65536 -> 87.1 ms (x3.88); JSON-LD openers through jobPostingText 32768 -> 5.2 ms, 65536 -> 19.4 ms (x3.70). Control: a benign 2 MiB page of <p>...</p> prose -> 122.7 ms, output truncated to 12 000 characters. Extrapolating the quadratic to the accepted 2 MiB cap gives 1 707.8 ms x 1024 = 1 749 s from the 64 KiB point and 6 866.5 ms x 256 = 1 758 s from the 128 KiB point — two independent estimates agreeing on roughly 29 minutes of CPU for a single import request whose payload compresses to a few KiB on the wire. These numbers independently reproduce the hunter's (30.4 / 142.5 / 447.1 / 1 729.6 / 6 713.1 ms) within run-to-run noise. Incidental, outside this finding's root cause: htmlToText('<p>Job &#1114112; ad</p>') and the hex form both throw an uncaught RangeError: Invalid code point 1114112 from String.fromCodePoint in decodeEntities (htmlText.ts:46-51), which would surface as a non-ConvexError failure of the import.

### Remediation and regression

Bound the parse work, not only the transfer. The load-bearing change is to make every character class unable to cross the next '<' or '>' ([^<>] instead of [^>]) so each match attempt is bounded by the distance to the nearest delimiter rather than by the length of the document, and to replace the lazy cross-tag scan for dropped elements with an indexOf-driven loop that never re-scans. Slicing the body to an explicit parse budget before any regex is a second, independent bound: on its own it is not sufficient (256 KiB of '<' still costs ~27 s with the current classes), but with the class fix it makes the worst case provably small. Add the regression test below so widening the classes back to [^>] fails loudly. Two review notes on the version of this fix proposed by the hunter: text.toLowerCase() must be hoisted out of the dropElement loop, otherwise a page with many openers reintroduces the same O(n^2) through the lowercasing itself; and jobPostingText must slice to the budget too, since its own matcher has the same shape. Separately (different root cause, not fixed by this change): decodeEntities should guard String.fromCodePoint against values above U+10FFFF.

`convex/lib/htmlText.ts`:

```ts
/** Hard budget on what the regex passes may see; a job ad never needs more. */
const PARSE_BUDGET = 256 * 1024

/** Linear: find each opener, then the next closer with indexOf; never re-scan. */
function dropElement(text: string, tag: string): string {
  const open = new RegExp(`<${tag}\\b[^<>]*>`, 'gi')
  // Hoisted: lowercasing inside the loop would reintroduce O(n^2) on a page
  // with many openers, which is the bug this function exists to remove.
  const haystack = text.toLowerCase()
  let out = ''
  let last = 0
  for (let m = open.exec(text); m; m = open.exec(text)) {
    out += text.slice(last, m.index) + ' '
    const close = haystack.indexOf(`</${tag}`, open.lastIndex)
    if (close === -1) { last = open.lastIndex; continue }
    const end = text.indexOf('>', close)
    last = end === -1 ? text.length : end + 1
    open.lastIndex = last
  }
  return out + text.slice(last)
}

export function htmlToText(html: string, maxLength = 12_000): string {
  let text = html.slice(0, PARSE_BUDGET)
  for (const tag of DROPPED_ELEMENTS) text = dropElement(text, tag)
  // [^<>] instead of [^>] is the load-bearing change: every attempt is now
  // bounded by the distance to the next '<' or '>', so a run of openers with
  // no closer costs O(1) per position instead of O(n).
  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|section|article|br|li|tr|h[1-6]|ul|ol|table)\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]+>/g, ' ')

  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}

// In jobPostingText, same change to the JSON-LD matcher, and slice first:
//   const LD_JSON =
//     /<script\b[^<>]*type=["']application\/ld\+json["'][^<>]*>([\s\S]*?)<\/script\s*>/gi
//   export function jobPostingText(html: string, maxLength = 12_000) {
//     const source = html.slice(0, PARSE_BUDGET)
//     for (const [, block] of source.matchAll(LD_JSON)) { ... }
//   }

```

`convex/lib/htmlText.test.ts`:

```ts
it('stays linear on a page that is nothing but unclosed openers', () => {
  const t0 = performance.now()
  htmlToText('<'.repeat(262_144))
  htmlToText('<p '.repeat(100_000))
  jobPostingText('<script type="application/ld+json">'.repeat(20_000))
  // Pre-fix these three cost minutes; the assertion fails loudly if the
  // character classes are ever widened back to [^>].
  expect(performance.now() - t0).toBeLessThan(500)
})

```

## LOW — projects.restore is guarded one tier below projects.archive: any member who can see an archived role reverses the archival, edits its frozen questions and reopens every closed candidate link

Fingerprint: `convex/projects.ts:restore:requireProjectAccess-weaker-than-archive`

projects.archive was deliberately raised to requireProjectOwnerOrAdmin (owner, admin or the project's creator) because archiving closes every candidate link of the role at once, and requireProjectEditable freezes archived projects so their questions and criteria cannot be changed after the fact. projects.restore, the exact inverse transition, still uses requireProjectAccess, which any org member who can see the project satisfies with no role check. A plain member (role 'member', not the creator) therefore calls restore on an archived project (status -> draft), which lifts the archived freeze: questions.update and criteria.update succeed again, and projects.publish (also member-level, requireProjectEditable) puts the project back to active, at which point evaluateSessionGate reports every still-pending session of that project as 'ready' instead of 'closed'. The member has undone an owner/admin decision, rewritten what past and future candidates are asked, and reopened links the admin closed. The visibility layer still applies — restore on a restricted project the member is not named on fails not_found, verified locally — so the defect is strictly the missing role tier, not a visibility hole.

**Root cause.** convex/projects.ts:328 guards `restore` with requireProjectAccess (org membership + project visibility, convex/lib/projectAccess.ts:50-65) while the paired `archive` at convex/projects.ts:315 requires requireProjectOwnerOrAdmin (convex/lib/projectAccess.ts:88-104). The archived freeze in requireProjectEditable (convex/lib/projectAccess.ts:81-83) and the publish transition (convex/projects.ts:289) are both member-level, so the only privileged step in the archive lifecycle is one-directional and any member can walk the state back.

**Intended behaviour.** The doc comment at convex/projects.ts:302-311 states that archiving 'is no longer unprivileged' precisely because it cuts every candidate's link at once; the state that decision produces (archived, frozen questions, closed links) should only be reversible by the same tier that produced it — owner, admin, or the project's creator — exactly as requireProjectOwnerOrAdmin defines it.

### Trace

1. **entrypoint** `convex/projects.ts:325` — projects.restore (public mutation): A plain org member calls the public mutation restore with the id of an archived project of their own org.
2. **propagation** `convex/projects.ts:328` — projects.restore handler: Only requireProjectAccess is applied; no role or creator check, unlike archive at line 315.
3. **propagation** `convex/lib/projectAccess.ts:50` — requireProjectAccess: Resolves the project, enforces org membership and canSeeProject, and returns; it never inspects member.role or project.createdBy.
4. **propagation** `convex/projects.ts:333` — projects.restore handler: The project row is patched to status 'draft' and archivedAt is cleared.
5. **propagation** `convex/lib/projectAccess.ts:81` — requireProjectEditable: The archived freeze only throws project_archived while status === 'archived', so the restore just performed lifts it for the same caller.
6. **propagation** `convex/questions.ts:22` — loadQuestionForEdit (questions.update): The same member now edits the content of a question of the previously frozen role, because requireProjectEditable succeeds on a draft project.
7. **propagation** `convex/projects.ts:289` — projects.publish handler: publish requires only requireProjectEditable, so the same member sets the project back to status 'active'.
8. **sink** `convex/lib/sessionState.ts:78` — evaluateSessionGate: The gate returns 'closed' for any project whose status is not 'active'; with the project active again every still-pending session of the role is 'ready' and its candidate can record against the rewritten question set.

### Evidence

- `convex/projects.ts:315` — archive calls requireProjectOwnerOrAdmin — the tier the paired transition uses.
- `convex/projects.ts:303` — Doc comment: archiving is 'the most destructive unprivileged action in this module, so it is no longer unprivileged'; it cuts every candidate link at once, and the previous asymmetry was 'the wrong way round'.
- `convex/projects.ts:328` — restore calls requireProjectAccess only — membership plus visibility, no role.
- `convex/lib/projectAccess.ts:82` — requireProjectEditable throws project_archived only while the status is archived, so restore is what unfreezes questions and criteria.
- `convex/lib/projectAccess.ts:88` — requireProjectOwnerOrAdmin (admins, owners, or the project's creator) is the tier restore should share with archive.
- `convex/guards.test.ts:313` — A regression test asserts a plain member cannot archive a live role; there is no mirror test for restore anywhere in the suite.
- `src/routes/app/$orgSlug/projects.index.tsx:46` — The restore mutation is wired into the project list UI with no role condition anywhere in the file, so the action is offered to every member.

### Principal and resource

An org member who disagrees with an admin's decision to close a role, or who wants to change what candidates on a closed role were asked, calls three member-level public mutations from the browser console with the app's Convex client, or simply clicks the restore control the project list already renders for them.

### Conditions and containment

- **authentication_level**: Registered, authenticated user provisioned in the Convex users table.
- **authorization_role**: Plain member of the organisation (role 'member', not the project's creator, not admin or owner) who can see the project: any unrestricted project, or a restricted one they are named on. Verified locally: restore on a restricted project the member is not named on still fails not_found.
- **data_state**: The target project is in status 'archived'; for the link-reopening effect at least one of its sessions is still pending or in_progress (archive does not cancel sessions).

### Native input and bounded instructions

Inputs:

- `api.projects.restore { projectId: <id of an archived project visible to the member> }`
- `api.questions.update { questionId: <question of that project>, content: 'rewritten by member' }`
- `api.projects.publish { projectId: <same project id> }`

Instructions:

1. Verifier re-check, independent of the hunter's harness (no deployment, no network, no dependency installation). From /root/security-audit-skill/interw/run-1/agents/verifier-v05/scratch, run: /root/security-audit-skill/interw/run-1/parent-tools/sandbox.sh verifier-v05 'node --experimental-strip-types --import ./vtmp/register.mjs ./verify-harness.mjs' (new mount+net namespace with no interfaces, read-only target, env -i, prlimit cpu=20 fsize=8MiB nofile=256 nproc=64, 60 s wall clock).
2. verify-harness.mjs imports the real convex/projects.ts, convex/questions.ts and convex/lib/{auth,projectAccess,sessionState}.ts, replacing only convex/values, convex/server, convex/_generated/*, convex/auth.ts, convex/email.ts, convex/emailTemplates.ts, @convex-dev/resend and @convex-dev/rate-limiter with stubs, and drives them against an in-memory ctx.db. Seeds one dummy org with an owner (creator of every project), an admin and two plain members, an unrestricted archived project holding one question and one pending session, plus a restricted archived project the acting member is not named on as a negative control.
3. Read section V1 of scratch/verify-harness.log (promote this file as evidence: it is the file the confirmed observed_result below is taken from).

### Observed output and invariant proved

V1.1 member archive(live role) -> {ok:false, error:'insufficient_role'}. V1.2 member questions.update on the archived role -> {ok:false, error:'project_archived'}. V1.3 candidate gate for the archived role's pending session -> 'closed'. V1.4 member restore(archived) -> {ok:true}; V1.5 status becomes 'draft'. V1.6 member questions.update now -> {ok:true}; V1.7 the question content is 'rewritten by member'. V1.8 member publish -> {ok:true}; V1.9 status becomes 'active'. V1.10 the gate for that same untouched pending session is now 'ready'. Controls: V1.11 the same member's restore on a restricted archived project they are not named on -> {ok:false, error:'not_found'}; V1.12 the admin's restore on it -> {ok:true}.

### Remediation and regression

Guard restore with the same tier as archive — requireProjectOwnerOrAdmin, which admits owners, admins and the project's creator — so that undoing an archival requires the authority that performed it, and add the mirror regression test beside the archive one in convex/guards.test.ts so the pair cannot drift apart again.

`convex/projects.ts`:

```ts
export const restore = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    // Same tier as `archive`: undoing an archival is the same decision in
    // reverse — it lifts the freeze on the questions and, via `publish`,
    // reopens every candidate link the archival closed.
    const { project } = await requireProjectOwnerOrAdmin(ctx, projectId)
    if (project.status !== 'archived') return null
    // Back to draft, never straight to active: the reason it was archived may
    // still hold, and re-publishing is one deliberate click.
    await ctx.db.patch('projects', projectId, {
      status: 'draft',
      archivedAt: undefined,
    })
    return null
  },
})
```

`convex/guards.test.ts`:

```ts
it('refuses a plain member the right to restore an archived role', async () => {
  await as(t, 'acmeOwner').mutation(api.projects.archive, {
    projectId: w.openProjectId,
  })
  await expect(
    as(t, 'acmeMember').mutation(api.projects.restore, {
      projectId: w.openProjectId,
    }),
  ).rejects.toThrow()

  const project = await t.run(async (ctx) =>
    ctx.db.get('projects', w.openProjectId),
  )
  expect(project?.status).toBe('archived')
})
```

