/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

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

vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: { sendEmail: () => Promise.resolve('provider-id-stub') },
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type Fixture = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  userId: Id<'users'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<Fixture> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_recruiter',
      email: 'r@acme.test',
      superAdmin: false,
      createdAt: 0,
    })
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: userId,
      createdAt: 0,
    })
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
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
      createdBy: userId,
      createdAt: 0,
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    return { orgId, projectId, userId }
  })
}

const asRecruiter = (t: ReturnType<typeof newTest>) =>
  t.withIdentity({ subject: 'ba_recruiter' })

describe('inviting at scale', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  it('still returns the open session for an address invited twice', async () => {
    const first = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    const second = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'ALEX@example.test' }],
    })

    expect(second.created).toBe(0)
    expect(second.results[0].sessionId).toBe(first.results[0].sessionId)
  })

  it('invites again once the previous session is finished', async () => {
    const first = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', first.results[0].sessionId, {
        status: 'completed',
      })
    })

    const second = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    expect(second.created).toBe(1)
    expect(second.results[0].sessionId).not.toBe(first.results[0].sessionId)
  })
})

/**
 * The report notification deduplicated by reading the organisation's last 200
 * emails. A bulk campaign pushes the `report-ready` row out of that window,
 * and the pool retries this job — so the whole organisation received the same
 * report twice.
 */
describe('the report notification', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  async function completedSessionWithReport(): Promise<Id<'sessions'>> {
    return await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: 'n'.repeat(43),
        candidateName: 'Alex Martin',
        candidateEmail: 'alex@example.test',
        status: 'completed',
        lastQuestionIndex: 1,
        invitedBy: f.userId,
        invitedAt: 0,
        completedAt: 1,
      })
      await ctx.db.insert('reports', {
        orgId: f.orgId,
        sessionId,
        overallScore: 71,
        recommendation: 'yes',
        executiveSummary: 'Solid.',
        criteriaScores: [],
        strengths: ['Something'],
        concerns: [],
        model: 'test',
        generatedAt: 0,
      })
      return sessionId
    })
  }

  it('sends once even behind 300 other emails', async () => {
    const sessionId = await completedSessionWithReport()

    expect(
      await t.mutation(internal.notifications.sendReportReady, { sessionId }),
    ).toBe(true)

    // A bulk campaign lands after it — `createdAt` strictly later, so the
    // `report-ready` row falls out of the 200-row window the old guard read.
    const after = Date.now() + 1_000
    await t.run(async (ctx) => {
      for (let i = 0; i < 300; i++) {
        await ctx.db.insert('emailLog', {
          orgId: f.orgId,
          template: 'candidate-invitation',
          recipient: `c${i}@example.test`,
          status: 'sent',
          createdAt: after + i,
        })
      }
    })

    expect(
      await t.mutation(internal.notifications.sendReportReady, { sessionId }),
    ).toBe(false)

    const sent = await t.run(async (ctx) =>
      ctx.db
        .query('emailLog')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
    )
    expect(sent.filter((e) => e.template === 'report-ready')).toHaveLength(1)
  })
})

/**
 * The dashboard is a reactive query: it re-runs on every write to any session
 * of the organisation — so on every `markSegmentUploaded` of every candidate
 * mid-interview. It used to carry up to 400 extra indexed reads with it, one
 * per completed session, for every open tab.
 */
describe('the dashboard', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  it('reads the score off the session, not out of the reports table', async () => {
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: 'd'.repeat(43),
        candidateName: 'Alex Martin',
        candidateEmail: 'alex@example.test',
        status: 'completed',
        lastQuestionIndex: 1,
        invitedBy: f.userId,
        invitedAt: 0,
        completedAt: 1,
        overallScore: 83,
        recommendation: 'strong_yes',
      }),
    )
    // Deliberately no `reports` row: if the dashboard still queried that
    // table, the score would come back null and the review count would be 0.
    const overview = await asRecruiter(t).query(api.dashboard.overview, {
      orgId: f.orgId,
      now: Date.now(),
    })

    expect(overview.awaitingReview).toBe(1)
    expect(overview.recent[0]).toMatchObject({ sessionId, score: 83 })
  })

  it('has the queue write the headline onto the session', async () => {
    const sessionId = await t.run(async (ctx) =>
      ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: 'p'.repeat(43),
        candidateName: 'Alex Martin',
        candidateEmail: 'alex@example.test',
        status: 'completed',
        lastQuestionIndex: 1,
        invitedBy: f.userId,
        invitedAt: 0,
        completedAt: 1,
      }),
    )

    await t.mutation(internal.pipeline.saveReport, {
      sessionId,
      report: {
        overallScore: 64,
        recommendation: 'maybe',
        executiveSummary: 'Mixed.',
        criteriaScores: [],
        strengths: ['Something'],
        concerns: [],
      },
      partial: false,
      model: 'test',
    })

    const session = await t.run(async (ctx) => ctx.db.get('sessions', sessionId))
    expect(session).toMatchObject({ overallScore: 64, recommendation: 'maybe' })
  })
})
