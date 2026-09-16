/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { ConvexError } from 'convex/values'
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

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

const TOKEN = 'j'.repeat(43)

type Seed = {
  projectId: Id<'projects'>
  sessionId: Id<'sessions'>
  questionIds: Array<Id<'questions'>>
}

async function seed(
  t: ReturnType<typeof newTest>,
  { sessionCount }: { sessionCount: number },
): Promise<Seed> {
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
      sessionCount,
      completedSessionCount: 0,
    })
    const questionIds: Array<Id<'questions'>> = []
    for (let i = 0; i < 3; i++) {
      questionIds.push(
        await ctx.db.insert('questions', {
          orgId,
          projectId,
          orderIndex: i,
          content: `Question ${i}`,
          maxResponseSeconds: 120,
        }),
      )
    }
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: TOKEN,
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'completed',
      consentAcceptedAt: 1,
      lastQuestionIndex: 3,
      invitedBy: userId,
      invitedAt: 0,
      completedAt: 1,
    })
    // The candidate answered question 2, recorded at index 2.
    const segmentId = await ctx.db.insert('segments', {
      orgId,
      sessionId,
      questionId: questionIds[2],
      questionIndex: 2,
      audioKey: 'orgs/o/sessions/s/q2.weba',
      uploadState: 'uploaded',
      uploadAttempts: 1,
      transcriptionState: 'done',
      recordedAt: 0,
    })
    await ctx.db.insert('transcripts', {
      orgId,
      sessionId,
      segmentId,
      text: 'Ma réponse à la troisième question.',
      words: [{ start: 0, end: 3, text: 'Ma réponse à la troisième question.' }],
      model: 'test',
      createdAt: 0,
    })
    return { projectId, sessionId, questionIds }
  })
}

/** Delete question 0 the way `questions.remove` used to, renumbering the rest. */
async function deleteFirstQuestionAndRenumber(
  t: ReturnType<typeof newTest>,
  s: Seed,
): Promise<void> {
  await t.run(async (ctx) => {
    await ctx.db.delete('questions', s.questionIds[0])
    await ctx.db.patch('questions', s.questionIds[1], { orderIndex: 0 })
    await ctx.db.patch('questions', s.questionIds[2], { orderIndex: 1 })
  })
}

/**
 * `orderIndex` is a display order. `questionId` is an identity. Joining an
 * answer to its question by the former meant that deleting one question slid
 * every recorded answer one question along — in reports already written as
 * much as in new ones. The report was not in error; it was wrong, and it
 * looked right.
 */
describe('answers are joined to questions by id', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(() => {
    t = newTest()
  })

  it('keeps an answer under its own question after a renumbering', async () => {
    const s = await seed(t, { sessionCount: 0 })
    await deleteFirstQuestionAndRenumber(t, s)

    const inputs = await t.query(internal.pipeline.reportInputs, {
      sessionId: s.sessionId,
    })
    if (inputs === null || inputs.alreadyGenerated) throw new Error('no inputs')
    expect(inputs.answers[0].question).toBe('Question 2')
  })

  it('shows the recruiter the question that was actually asked', async () => {
    const s = await seed(t, { sessionCount: 0 })
    await deleteFirstQuestionAndRenumber(t, s)

    const detail = await t
      .withIdentity({ subject: 'ba_recruiter' })
      .query(api.reports.forSession, { sessionId: s.sessionId })
    expect(detail.answers[0].question).toBe('Question 2')
  })

  it('shows a share viewer the question that was actually asked', async () => {
    const s = await seed(t, { sessionCount: 0 })
    const token = 'h'.repeat(43)
    await t.run(async (ctx) => {
      const session = await ctx.db.get('sessions', s.sessionId)
      const reportId = await ctx.db.insert('reports', {
        orgId: session!.orgId,
        sessionId: s.sessionId,
        overallScore: 70,
        recommendation: 'yes',
        executiveSummary: 'Fine.',
        criteriaScores: [],
        strengths: ['Something'],
        concerns: [],
        model: 'test',
        generatedAt: 0,
      })
      await ctx.db.insert('reportShares', {
        orgId: session!.orgId,
        reportId,
        token,
        createdBy: session!.invitedBy,
        viewCount: 0,
        createdAt: 0,
      })
    })
    await deleteFirstQuestionAndRenumber(t, s)

    const view = await t.query(api.shares.view, { token, now: Date.now() })
    expect(view.report?.answers[0].question).toBe('Question 2')
  })

  it('tells the candidate which question they have already answered', async () => {
    const s = await seed(t, { sessionCount: 0 })
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', s.sessionId, { status: 'in_progress' })
    })
    await deleteFirstQuestionAndRenumber(t, s)

    const result = await t.query(api.interview.questions, {
      token: TOKEN,
      now: Date.now(),
    })
    const answered = result.questions.filter((q) => q.answered)
    expect(answered).toHaveLength(1)
    expect(answered[0].content).toBe('Question 2')
  })
})

/**
 * Fixing the join stops the answers moving. It does not stop the numbering a
 * candidate mid-interview is looking at from changing under them, so the trame
 * is frozen once anyone has been invited.
 */
describe('the trame is frozen once a candidate exists', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(() => {
    t = newTest()
  })

  it('refuses to delete a question on a role with sessions', async () => {
    const s = await seed(t, { sessionCount: 1 })
    await expect(
      t
        .withIdentity({ subject: 'ba_recruiter' })
        .mutation(api.questions.remove, { questionId: s.questionIds[0] }),
    ).rejects.toThrow(ConvexError)
  })

  it('refuses to reorder on a role with sessions', async () => {
    const s = await seed(t, { sessionCount: 1 })
    await expect(
      t.withIdentity({ subject: 'ba_recruiter' }).mutation(
        api.questions.reorder,
        {
          projectId: s.projectId,
          orderedIds: [s.questionIds[2], s.questionIds[1], s.questionIds[0]],
        },
      ),
    ).rejects.toThrow(ConvexError)
  })

  it('still allows both while nobody has been invited', async () => {
    const s = await seed(t, { sessionCount: 0 })
    await t
      .withIdentity({ subject: 'ba_recruiter' })
      .mutation(api.questions.reorder, {
        projectId: s.projectId,
        orderedIds: [s.questionIds[2], s.questionIds[1], s.questionIds[0]],
      })
    await t
      .withIdentity({ subject: 'ba_recruiter' })
      .mutation(api.questions.remove, { questionId: s.questionIds[0] })

    const left = await t.run(async (ctx) =>
      ctx.db
        .query('questions')
        .withIndex('by_project', (q) => q.eq('projectId', s.projectId))
        .collect(),
    )
    expect(left).toHaveLength(2)
  })
})
