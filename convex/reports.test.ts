/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
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

type Seed = {
  sessionId: Id<'sessions'>
  segmentId: Id<'segments'>
}

async function seed(t: ReturnType<typeof convexTest>): Promise<Seed> {
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
      sessionCount: 1,
      completedSessionCount: 1,
    })
    const questionId = await ctx.db.insert('questions', {
      orgId,
      projectId,
      orderIndex: 0,
      content: 'Tell me about a migration you led.',
      maxResponseSeconds: 120,
    })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: 'r'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: userId,
      invitedAt: 0,
      completedAt: 1,
    })
    const segmentId = await ctx.db.insert('segments', {
      orgId,
      sessionId,
      questionId,
      questionIndex: 0,
      audioKey: 'orgs/o/sessions/s/q0.weba',
      durationSeconds: 60,
      uploadState: 'uploaded',
      uploadAttempts: 1,
      recordedAt: 0,
    })
    return { sessionId, segmentId }
  })
}

/**
 * Audit 2026-09-22,
 * `convex/pipeline.ts:reportInputs:candidate-reported-durationSeconds-in-report`.
 *
 * The report no longer measures the candidate's own number; the recruiter
 * page must not show it either, once the server has measured the answer.
 */
describe('the answer length shown to the recruiter', () => {
  let t: ReturnType<typeof convexTest>
  let s: Seed

  beforeEach(async () => {
    t = convexTest(schema, modules)
    s = await seed(t)
  })

  const lengthShown = async () => {
    const view = await t
      .withIdentity({ subject: 'ba_recruiter' })
      .query(api.reports.forSession, { sessionId: s.sessionId })
    return view.answers[0].durationSeconds
  }

  it('is what the server measured, not what the browser reported', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('segments', s.segmentId, { measuredSeconds: 9.5 })
    })
    expect(await lengthShown()).toBe(9.5)
  })

  it("falls back to the browser's figure for an answer never measured", async () => {
    expect(await lengthShown()).toBe(60)
  })
})

/**
 * Audit 2026-09-22, h09. The page's pipeline trail carried `jobLog.error`,
 * which holds raw provider output and, until now, an operator's address.
 * Both are for operators; the recruiter gets the step and its outcome.
 */
describe('the pipeline trail shown to the recruiter', () => {
  it('carries no error text', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await t.run(async (ctx) => {
      const session = await ctx.db.get('sessions', s.sessionId)
      await ctx.db.insert('jobLog', {
        orgId: session!.orgId,
        sessionId: s.sessionId,
        step: 'report',
        outcome: 'failed',
        attempt: 1,
        error: 'completion failed with HTTP 401: invalid key sk-…',
        at: 1,
      })
    })

    const view = await t
      .withIdentity({ subject: 'ba_recruiter' })
      .query(api.reports.forSession, { sessionId: s.sessionId })

    expect(view.pipeline).toEqual([
      { step: 'report', outcome: 'failed', at: 1 },
    ])
  })
})

/**
 * Removing a colleague takes away their access, not their credit: the
 * decision they made still names them, marked as no longer a member.
 */
describe('who made the decision', () => {
  const decidedBy = async (t: ReturnType<typeof convexTest>, s: Seed) =>
    (
      await t
        .withIdentity({ subject: 'ba_recruiter' })
        .query(api.reports.forSession, { sessionId: s.sessionId })
    ).session.recruiterDecisionBy

  async function decideAsColleague(
    t: ReturnType<typeof convexTest>,
    s: Seed,
  ) {
    return await t.run(async (ctx) => {
      const session = await ctx.db.get('sessions', s.sessionId)
      const colleague = await ctx.db.insert('users', {
        betterAuthId: 'ba_colleague',
        email: 'colleague@acme.test',
        name: 'Cora Colleague',
        superAdmin: false,
        createdAt: 0,
      })
      const membership = await ctx.db.insert('organizationMembers', {
        orgId: session!.orgId,
        userId: colleague,
        role: 'member',
        joinedAt: 0,
      })
      await ctx.db.patch('sessions', s.sessionId, {
        recruiterDecision: 'shortlisted',
        recruiterDecisionBy: colleague,
        recruiterDecisionAt: 1,
      })
      return { colleague, membership }
    })
  }

  it('names a current colleague, and nothing more', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    await decideAsColleague(t, s)
    expect(await decidedBy(t, s)).toEqual({
      name: 'Cora Colleague',
      removed: false,
    })
  })

  it('still names a colleague removed since', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const { membership } = await decideAsColleague(t, s)
    await t.run((ctx) => ctx.db.delete('organizationMembers', membership))
    expect(await decidedBy(t, s)).toEqual({
      name: 'Cora Colleague',
      removed: true,
    })
  })

  it('falls back to no name once the account is gone', async () => {
    const t = convexTest(schema, modules)
    const s = await seed(t)
    const { colleague, membership } = await decideAsColleague(t, s)
    await t.run(async (ctx) => {
      await ctx.db.delete('organizationMembers', membership)
      await ctx.db.delete('users', colleague)
    })
    expect(await decidedBy(t, s)).toEqual({ name: null, removed: true })
  })
})
