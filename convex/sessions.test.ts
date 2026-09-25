/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/**
 * Better Auth resolves the caller through its own component, which
 * `convex-test` does not run. Standing in for it here is what lets the real
 * guards (`requireAppUser` → `requireOrgMember` → …) execute against a real
 * identity: the mock answers "who is calling", and every authorisation
 * decision after that is the product's own code.
 */
vi.mock('./auth', () => ({
  authComponent: {
    safeGetAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      return identity ? { _id: identity.subject } : null
    },
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) throw new Error('Unauthenticated')
      return { _id: identity.subject }
    },
    registerRoutes: () => {},
  },
  createAuth: () => ({}),
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  // The rate limiter is consumed by `invite` before it writes anything, so
  // the component has to be there for the mutation to reach its own logic.
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type Fixture = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  recruiter: Id<'users'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<Fixture> {
  return await t.run(async (ctx) => {
    const recruiter = await ctx.db.insert('users', {
      betterAuthId: 'ba_recruiter',
      email: 'r@acme.test',
      superAdmin: false,
      createdAt: 0,
    })
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: recruiter,
      createdAt: 0,
    })
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId: recruiter,
      role: 'owner',
      joinedAt: 0,
    })
    const projectId = await ctx.db.insert('projects', {
      orgId,
      slug: 'backend',
      title: 'Backend',
      status: 'active',
      language: 'fr',
      introMode: 'none',
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: recruiter,
      createdAt: 0,
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    return { orgId, projectId, recruiter }
  })
}

const asRecruiter = (t: ReturnType<typeof newTest>) =>
  t.withIdentity({ subject: 'ba_recruiter' })

/**
 * Retention only covers what it can name. An interview that is never finished
 * — the majority in a hiring funnel — used to get no clock at all, so its CV,
 * address and part-recorded answers were kept without limit.
 */
describe('the retention clock', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  it('starts at the invitation, not at the interview', async () => {
    const { results } = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })

    const session = await t.run(async (ctx) =>
      ctx.db.get('sessions', results[0].sessionId),
    )
    expect(session?.purgeAfter).toEqual(expect.any(Number))
    expect(session?.purgeAfter).toBe(
      session!.invitedAt + INVITED_RETENTION_MS_EXPECTED,
    )
  })

  it('is pushed out when the candidate finishes', async () => {
    const { results } = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    const sessionId = results[0].sessionId
    const invited = await t.run(async (ctx) => ctx.db.get('sessions', sessionId))
    const token = invited!.accessToken

    // Only an interview that was actually sat can be finished.
    await t.mutation(api.candidate.acceptConsent, { token })
    await t.mutation(api.interview.start, { token })
    await t.mutation(api.interview.finish, { token })

    const finished = await t.run(async (ctx) =>
      ctx.db.get('sessions', sessionId),
    )
    expect(finished!.purgeAfter).toBeGreaterThan(invited!.purgeAfter!)
  })

  it('makes an abandoned session reachable by the purge', async () => {
    const { results } = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    const sessionId = results[0].sessionId
    const session = await t.run(async (ctx) => ctx.db.get('sessions', sessionId))

    const due = await t.query(internal.purge.sessionsDueForPurge, {
      before: session!.purgeAfter! + 1,
      limit: 25,
    })
    expect(due).toEqual([sessionId])
  })
})

/** Six months from the invitation. Mirrors INVITED_RETENTION_MS. */
const INVITED_RETENTION_MS_EXPECTED = 183 * 24 * 60 * 60 * 1000

/**
 * Audit E4: the candidate table could not compare anyone, because the list it
 * reads never carried the score. The headline result is denormalised onto the
 * session by the queue; the recruiter row has to pass it through.
 */
describe('the recruiter list', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  it('carries the score and the recommendation, and never the token', async () => {
    await t.run(async (ctx) => {
      for (const [name, score] of [
        ['Scored', 82],
        ['Waiting', undefined],
      ] as const) {
        await ctx.db.insert('sessions', {
          orgId: f.orgId,
          projectId: f.projectId,
          accessToken: name.padEnd(43, 'x'),
          candidateName: name,
          candidateEmail: `${name.toLowerCase()}@example.test`,
          status: score === undefined ? 'pending' : 'completed',
          lastQuestionIndex: 0,
          invitedBy: f.recruiter,
          invitedAt: 0,
          overallScore: score,
          recommendation: score === undefined ? undefined : 'strong_yes',
        })
      }
    })

    const { page } = await asRecruiter(t).query(api.sessions.listByProject, {
      projectId: f.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    const byName = Object.fromEntries(page.map((row) => [row.candidateName, row]))
    expect(byName.Scored).toMatchObject({
      overallScore: 82,
      recommendation: 'strong_yes',
    })
    expect(byName.Waiting).toMatchObject({
      overallScore: null,
      recommendation: null,
    })
    expect(JSON.stringify(page)).not.toContain('xxxx')
  })

  /** PR #45: a bounce older than the org's last 200 emails went unflagged. */
  it('flags a failed invitation per candidate, however much mail came after', async () => {
    await t.run(async (ctx) => {
      const session = async (name: string) =>
        ctx.db.insert('sessions', {
          orgId: f.orgId,
          projectId: f.projectId,
          accessToken: name.padEnd(43, 'x'),
          candidateName: name,
          candidateEmail: `${name.toLowerCase()}@example.test`,
          status: 'pending',
          lastQuestionIndex: 0,
          invitedBy: f.recruiter,
          invitedAt: 0,
        })
      const log = async (
        sessionId: Id<'sessions'> | undefined,
        status: 'sent' | 'delivered' | 'bounced',
        template = 'candidate-invitation',
      ) =>
        ctx.db.insert('emailLog', {
          orgId: f.orgId,
          template,
          recipient: 'x@example.test',
          status,
          sessionId,
          createdAt: 0,
        })
      await log(await session('Bounced'), 'bounced')
      const retried = await session('Retried')
      await log(retried, 'bounced')
      await log(retried, 'delivered')
      await log(await session('Reported'), 'bounced', 'report-ready')
      for (let i = 0; i < 250; i++) await log(undefined, 'sent')
    })

    const { page } = await asRecruiter(t).query(api.sessions.listByProject, {
      projectId: f.projectId,
      paginationOpts: { numItems: 10, cursor: null },
    })
    const issues = Object.fromEntries(
      page.map((row) => [row.candidateName, row.deliveryIssue]),
    )
    expect(issues).toEqual({ Bounced: 'bounced', Retried: null, Reported: null })
  })
})

/**
 * "Copy the link" is shown to the people the server lets fetch it: the org's
 * owners and admins, and the role's creator. A team member who can see the
 * candidate still cannot mint an interview link for them.
 */
describe('the invitation link', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture
  let sessionId: Id<'sessions'>

  beforeEach(async () => {
    vi.stubEnv('SITE_URL', 'https://app.example.test/')
    t = newTest()
    f = await seed(t)
    sessionId = await t.run(async (ctx) => {
      const teammate = await ctx.db.insert('users', {
        betterAuthId: 'ba_teammate',
        email: 'mate@acme.test',
        superAdmin: false,
        createdAt: 0,
      })
      await ctx.db.insert('organizationMembers', {
        orgId: f.orgId,
        userId: teammate,
        role: 'member',
        joinedAt: 0,
      })
      await ctx.db.insert('projectShares', {
        orgId: f.orgId,
        projectId: f.projectId,
        userId: teammate,
        grantedBy: f.recruiter,
        grantedAt: 0,
      })
      return await ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: 't'.repeat(43),
        candidateName: 'Alex',
        candidateEmail: 'alex@example.test',
        status: 'pending',
        lastQuestionIndex: 0,
        invitedBy: f.recruiter,
        invitedAt: 0,
      })
    })
  })

  it('is handed to an owner', async () => {
    const { url } = await asRecruiter(t).query(api.sessions.invitationLink, {
      sessionId,
    })
    expect(url).toBe(`https://app.example.test/s/${'t'.repeat(43)}`)
  })

  it('is refused to a team member who is not the creator', async () => {
    await expect(
      t
        .withIdentity({ subject: 'ba_teammate' })
        .query(api.sessions.invitationLink, { sessionId }),
    ).rejects.toThrow(/insufficient_role/)
  })
})
