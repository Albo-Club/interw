/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { ConvexError } from 'convex/values'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
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

const modules = import.meta.glob('./**/*.ts')

// Imported through a non-literal specifier so `tsc` does not pull the
// package's raw sources into the program. See KNOWN_ISSUES.md.
const workpoolTest = '@convex-dev/workpool/test'

async function newTest() {
  const t = convexTest(schema, modules)
  const { register } = (await import(/* @vite-ignore */ workpoolTest)) as {
    register: (t: unknown, name: string) => void
  }
  register(t, 'mediaWorkpool')
  register(t, 'reportWorkpool')
  return t
}

type TestConvex = Awaited<ReturnType<typeof newTest>>

type Fixture = { orgId: Id<'organizations'>; projectId: Id<'projects'> }

async function seed(t: TestConvex): Promise<Fixture> {
  return await t.run(async (ctx) => {
    const admin = await ctx.db.insert('users', {
      betterAuthId: 'ba_admin',
      email: 'admin@acme.test',
      superAdmin: true,
      createdAt: 0,
    })
    await ctx.db.insert('users', {
      betterAuthId: 'ba_member',
      email: 'member@acme.test',
      superAdmin: false,
      createdAt: 0,
    })
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: admin,
      createdAt: 0,
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
      createdBy: admin,
      createdAt: 0,
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    return { orgId, projectId }
  })
}

const asAdmin = (t: TestConvex) =>
  t.withIdentity({ subject: 'ba_admin' })
const asMember = (t: TestConvex) =>
  t.withIdentity({ subject: 'ba_member' })

/**
 * `jobLog.by_step_and_outcome` was built for exactly this question and read by
 * nothing. An expired provider key produced four failed transcriptions per
 * interview in a table nobody looked at, and the first signal was a recruiter
 * asking where a report had got to.
 */
describe('the pipeline health screen', () => {
  let t: TestConvex
  let f: Fixture

  beforeEach(async () => {
    t = await newTest()
    f = await seed(t)
  })

  async function completedSession(
    fields: {
      overallScore?: number
      settled?: number
      expected?: number
    } = {},
  ): Promise<Id<'sessions'>> {
    return await t.run(async (ctx) => {
      const [user] = await ctx.db.query('users').take(1)
      return ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: Math.random().toString(36).padEnd(43, 'x').slice(0, 43),
        candidateName: 'Alex Martin',
        candidateEmail: 'alex@example.test',
        status: 'completed',
        lastQuestionIndex: 7,
        invitedBy: user._id,
        invitedAt: 0,
        completedAt: Date.now(),
        overallScore: fields.overallScore,
        segmentsSettled: fields.settled,
        segmentsExpected: fields.expected,
      })
    })
  }

  it('counts failures per step, in both windows', async () => {
    await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: 'z'.repeat(43),
        candidateName: 'Alex Martin',
        candidateEmail: 'alex@example.test',
        status: 'completed',
        lastQuestionIndex: 1,
        invitedBy: (await ctx.db.query('users').take(1))[0]._id,
        invitedAt: 0,
        completedAt: 1,
        overallScore: 70,
      })
      for (let i = 0; i < 3; i++) {
        await ctx.db.insert('jobLog', {
          orgId: f.orgId,
          sessionId,
          step: 'transcribe',
          outcome: 'failed',
          attempt: 1,
          at: Date.now() - 1_000,
        })
      }
      // Older than a day, inside a week.
      await ctx.db.insert('jobLog', {
        orgId: f.orgId,
        sessionId,
        step: 'report',
        outcome: 'failed',
        attempt: 1,
        at: Date.now() - 3 * 24 * 60 * 60 * 1000,
      })
    })

    const health = await asAdmin(t).query(api.admin.pipelineHealth, {})
    const day = health.windows.find((w) => w.days === 1)!
    const week = health.windows.find((w) => w.days === 7)!

    expect(
      day.counts.find((c) => c.step === 'transcribe')!.outcomes.failed.count,
    ).toBe(3)
    expect(
      day.counts.find((c) => c.step === 'report')!.outcomes.failed.count,
    ).toBe(0)
    expect(
      week.counts.find((c) => c.step === 'report')!.outcomes.failed.count,
    ).toBe(1)
  })

  it('names the interviews that finished without an assessment', async () => {
    const stuckId = await completedSession({ settled: 6, expected: 7 })
    await completedSession({ overallScore: 71 })

    const health = await asAdmin(t).query(api.admin.pipelineHealth, {})
    expect(health.stuck).toHaveLength(1)
    expect(health.stuck[0]).toMatchObject({
      sessionId: stuckId,
      settled: 6,
      expected: 7,
    })
  })

  it('does not call a session stuck when it has a report but no headline', async () => {
    // Completed before the headline was denormalised onto the session.
    const sessionId = await completedSession()
    await t.run(async (ctx) => {
      await ctx.db.insert('reports', {
        orgId: f.orgId,
        sessionId,
        overallScore: 70,
        recommendation: 'yes',
        executiveSummary: 'Fine.',
        criteriaScores: [],
        strengths: ['Something'],
        concerns: [],
        model: 'test',
        generatedAt: 0,
      })
    })

    const health = await asAdmin(t).query(api.admin.pipelineHealth, {})
    expect(health.stuck).toEqual([])
  })

  it('is closed to anyone who is not a super-admin', async () => {
    await expect(
      asMember(t).query(api.admin.pipelineHealth, {}),
    ).rejects.toThrow()
    await expect(t.query(api.admin.pipelineHealth, {})).rejects.toThrow()
  })
})

/**
 * Not a catch-up script: an operator names one session and says "go again",
 * and the decision is written to the same log as everything else that happened
 * to it.
 */
describe('relaunching a session', () => {
  let t: TestConvex
  let f: Fixture

  beforeEach(async () => {
    t = await newTest()
    f = await seed(t)
  })

  async function stuckSession(): Promise<Id<'sessions'>> {
    return await t.run(async (ctx) => {
      const [user] = await ctx.db.query('users').take(1)
      const sessionId = await ctx.db.insert('sessions', {
        orgId: f.orgId,
        projectId: f.projectId,
        accessToken: 'r'.repeat(43),
        candidateName: 'Alex Martin',
        candidateEmail: 'alex@example.test',
        status: 'completed',
        lastQuestionIndex: 1,
        invitedBy: user._id,
        invitedAt: 0,
        completedAt: 1,
      })
      const questionId = await ctx.db.insert('questions', {
        orgId: f.orgId,
        projectId: f.projectId,
        orderIndex: 0,
        content: 'Question 0',
        maxResponseSeconds: 120,
      })
      await ctx.db.insert('segments', {
        orgId: f.orgId,
        sessionId,
        questionId,
        questionIndex: 0,
        audioKey: 'orgs/o/sessions/s/q0.weba',
        uploadState: 'uploaded',
        uploadAttempts: 1,
        transcriptionState: 'failed',
        recordedAt: 0,
      })
      return sessionId
    })
  }

  it('records who asked, and puts the answer back in play', async () => {
    const sessionId = await stuckSession()
    await asAdmin(t).mutation(api.admin.relaunchSession, { sessionId })
    // `finishInProgressScheduledFunctions` only waits on callbacks that have
    // already fired, and `runAfter(0, …)` is a real `setTimeout(0)` — so yield
    // to the macrotask queue first, or there is nothing in flight to wait for.
    // Not `finishAllScheduledFunctions`: a Workpool's supervisor loop never
    // finishes. See KNOWN_ISSUES.md.
    await new Promise((resolve) => setTimeout(resolve, 0))
    await t.finishInProgressScheduledFunctions()

    const { log, segments } = await t.run(async (ctx) => ({
      log: await ctx.db
        .query('jobLog')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
      segments: await ctx.db
        .query('segments')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect(),
    }))

    const relaunches = log.filter((entry) => entry.step === 'relaunch')
    expect(relaunches).toHaveLength(1)
    // Audit 2026-09-22, h09: who asked is an id. The address used to sit in
    // `error`, which the recruiter's candidate page read back.
    const admin = await t.run(async (ctx) =>
      ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', 'admin@acme.test'))
        .unique(),
    )
    expect(relaunches[0].actorId).toBe(admin?._id)
    expect(JSON.stringify(relaunches[0])).not.toContain('admin@acme.test')
    // The answer that had failed for good gets another real attempt.
    expect(segments[0].transcriptionState).toBe('pending')
  })

  /**
   * Audit 2026-09-22, h09. A relaunch reset the report claim even while a
   * report job was running, so one click could queue a second paid
   * completion beside the first.
   */
  it('refuses while a report job holds the claim', async () => {
    const sessionId = await stuckSession()
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', sessionId, {
        reportJobEnqueuedAt: Date.now(),
      })
    })
    await expect(
      asAdmin(t).mutation(api.admin.relaunchSession, { sessionId }),
    ).rejects.toThrow(/report_in_progress/)
  })

  it('accepts a claim too old to be a running job', async () => {
    const sessionId = await stuckSession()
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', sessionId, {
        reportJobEnqueuedAt: Date.now() - 2 * 60 * 60 * 1000,
      })
    })
    await expect(
      asAdmin(t).mutation(api.admin.relaunchSession, { sessionId }),
    ).resolves.toBeNull()
  })

  it('refuses a session that is not finished', async () => {
    const sessionId = await stuckSession()
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', sessionId, { status: 'in_progress' })
    })
    await expect(
      asAdmin(t).mutation(api.admin.relaunchSession, { sessionId }),
    ).rejects.toThrow(ConvexError)
  })

  it('is closed to anyone who is not a super-admin', async () => {
    const sessionId = await stuckSession()
    await expect(
      asMember(t).mutation(api.admin.relaunchSession, { sessionId }),
    ).rejects.toThrow()
  })
})
