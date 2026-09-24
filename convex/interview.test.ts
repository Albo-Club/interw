/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import { segmentKey } from './lib/objectStore'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const sent = vi.hoisted(
  () => [] as Array<{ to: string; subject: string; html: string; text: string }>,
)

// Stood in for: what matters here is what would be sent, and to whom.
vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: {
    sendEmail: (
      _ctx: unknown,
      email: { to: string; subject: string; html: string; text: string },
    ) => {
      sent.push(email)
      return Promise.resolve('provider-id-stub')
    },
  },
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type Seed = { token: string; projectId: Id<'projects'> }

async function seed(t: ReturnType<typeof newTest>): Promise<Seed> {
  const token = 'k'.repeat(43)
  const projectId = await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_1',
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
    const project = await ctx.db.insert('projects', {
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
      completedSessionCount: 0,
      // Closed against the real server clock, long ago.
      expiresAt: 1_000,
    })
    await ctx.db.insert('questions', {
      orgId,
      projectId: project,
      orderIndex: 0,
      content: 'Tell me about a migration you led.',
      maxResponseSeconds: 120,
    })
    await ctx.db.insert('sessions', {
      orgId,
      projectId: project,
      accessToken: token,
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'pending',
      consentAcceptedAt: 1,
      lastQuestionIndex: 0,
      invitedBy: userId,
      invitedAt: 0,
    })
    return project
  })
  return { token, projectId }
}

/**
 * The candidate surface has the same shape of hole as the share surface: the
 * gate took `now` from whoever held the link. A role closed weeks ago went on
 * serving its questions and signing playback URLs to anyone who kept an old
 * invitation.
 */
describe('a closed role stays closed', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('refuses the questions however far back the caller claims to be', async () => {
    for (const now of [0, -1]) {
      await expect(
        t.query(api.interview.questions, { token: s.token, now }),
      ).rejects.toThrow('expired')
    }
  })

  it('mints no prompt media URL for a closed role', async () => {
    await expect(
      t.action(api.interview.promptMediaUrls, { token: s.token, now: 0 }),
    ).rejects.toThrow('expired')
  })

  it('serves the questions while the role is open', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('projects', s.projectId, { expiresAt: undefined })
    })
    const result = await t.query(api.interview.questions, {
      token: s.token,
      now: Date.now(),
    })
    expect(result.questions).toHaveLength(1)
  })
})

type OpenSeed = {
  token: string
  sessionId: Id<'sessions'>
  orgId: Id<'organizations'>
  questionIds: Array<Id<'questions'>>
}

/** An open role with four questions and a consented, started candidate. */
async function seedOpen(t: ReturnType<typeof newTest>): Promise<OpenSeed> {
  const token = 'r'.repeat(43)
  return t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_1',
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
      completedSessionCount: 0,
    })
    const questionIds: Array<Id<'questions'>> = []
    for (let orderIndex = 0; orderIndex < 4; orderIndex++) {
      questionIds.push(
        await ctx.db.insert('questions', {
          orgId,
          projectId,
          orderIndex,
          content: `Question ${orderIndex}`,
          maxResponseSeconds: 120,
        }),
      )
    }
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: token,
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'in_progress',
      consentAcceptedAt: 1,
      lastQuestionIndex: 0,
      invitedBy: userId,
      invitedAt: 0,
    })
    return { token, sessionId, orgId, questionIds }
  })
}

const AUDIO = { mimeType: 'audio/webm;codecs=opus', contentLength: 1_000 }
const VIDEO = { mimeType: 'video/webm', contentLength: 10_000 }

/**
 * E6. Two resume cursors disagreed after a failed answer: the welcome screen
 * read the monotone `lastQuestionIndex`, the runner scanned for the first
 * unanswered question, then advanced by one — into an answer already saved,
 * which it recorded over under the same object key.
 */
describe('one resume cursor, on the server', () => {
  let t: ReturnType<typeof newTest>
  let s: OpenSeed

  beforeEach(async () => {
    t = newTest()
    s = await seedOpen(t)
    // q0 saved, q1 failed, q2 saved — the shape a "Skip" leaves behind.
    await t.run(async (ctx) => {
      for (const [questionIndex, uploadState] of [
        [0, 'uploaded'],
        [1, 'failed'],
        [2, 'uploaded'],
      ] as const) {
        await ctx.db.insert('segments', {
          orgId: s.orgId,
          sessionId: s.sessionId,
          questionId: s.questionIds[questionIndex],
          questionIndex,
          // The key a WebM retry derives, so re-reserving schedules nothing.
          audioKey: segmentKey(s.orgId, s.sessionId, questionIndex, 'weba'),
          uploadState,
          uploadAttempts: 1,
          recordedAt: 0,
        })
      }
      // What the old monotone cursor would have said.
      await ctx.db.patch('sessions', s.sessionId, { lastQuestionIndex: 3 })
    })
  })

  it('resumes at the failed answer', async () => {
    const result = await t.query(api.interview.questions, {
      token: s.token,
      now: Date.now(),
    })
    expect(result.nextQuestionIndex).toBe(1)
    expect(result.questions.map((q) => q.answered)).toEqual([
      true,
      false,
      true,
      false,
    ])
  })

  /** M4 (language). The surface followed the browser, not the role. */
  it('tells every candidate screen the role’s language', async () => {
    const questions = await t.query(api.interview.questions, {
      token: s.token,
      now: Date.now(),
    })
    const privacy = await t.query(api.candidate.privacySummary, {
      token: s.token,
      now: Date.now(),
    })
    expect(questions.language).toBe('fr')
    expect(privacy.language).toBe('fr')
  })

  it('announces the same question on the welcome screen', async () => {
    const landing = await t.query(api.candidate.landing, {
      token: s.token,
      now: Date.now(),
    })
    expect(landing.gate.resumeAtIndex).toBe(1)
  })

  it('never lets a saved answer be recorded again', async () => {
    const result = await t.mutation(internal.interview.reserveSegment, {
      token: s.token,
      questionIndex: 2,
      audio: AUDIO,
    })
    expect(result).toEqual({ status: 'answered' })
    const saved = await t.run((ctx) =>
      ctx.db
        .query('segments')
        .withIndex('by_session', (q) =>
          q.eq('sessionId', s.sessionId).eq('questionIndex', 2),
        )
        .unique(),
    )
    expect(saved).toMatchObject({ uploadState: 'uploaded', uploadAttempts: 1 })
  })

  it('still lets the failed answer be recorded again', async () => {
    const slot = await t.mutation(internal.interview.reserveSegment, {
      token: s.token,
      questionIndex: 1,
      audio: AUDIO,
    })
    expect(slot.status).toBe('reserved')
  })
})

/**
 * F1. A retry that changes container — Chrome records WebM, Safari MP4 —
 * changes the object key. The row then named only the new object, and the old
 * one sat in the bucket where erasure could never find it.
 */
describe('re-reserving an answer', () => {
  let t: ReturnType<typeof newTest>
  let s: OpenSeed

  beforeEach(async () => {
    vi.useFakeTimers()
    t = newTest()
    s = await seedOpen(t)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function deletedAfter(
    second: { audio: typeof AUDIO; video?: typeof VIDEO },
  ): Promise<Array<string>> {
    await t.mutation(internal.interview.reserveSegment, {
      token: s.token,
      questionIndex: 0,
      audio: AUDIO,
      video: VIDEO,
    })
    const deleted: Array<string> = []
    const spy = vi
      .spyOn(await import('./lib/objectStore'), 'deleteObjects')
      .mockImplementation((keys: Array<string>) => {
        deleted.push(...keys)
        return Promise.resolve()
      })
    await t.mutation(internal.interview.reserveSegment, {
      token: s.token,
      questionIndex: 0,
      ...second,
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    spy.mockRestore()
    return deleted
  }

  const key = (extension: string) =>
    segmentKey(s.orgId, s.sessionId, 0, extension)

  it('deletes the objects the new reservation no longer names', async () => {
    const deleted = await deletedAfter({
      audio: { mimeType: 'audio/mp4', contentLength: 1_000 },
      video: { mimeType: 'video/mp4', contentLength: 10_000 },
    })
    expect(deleted.sort()).toEqual([key('weba'), key('webm')].sort())
  })

  it('deletes the old video when the retry is audio only', async () => {
    expect(await deletedAfter({ audio: AUDIO })).toEqual([key('webm')])
  })

  it('deletes nothing when the keys are unchanged', async () => {
    expect(await deletedAfter({ audio: AUDIO, video: VIDEO })).toEqual([])
  })
})

/**
 * The candidate had no trace of their interview and no way back to their data
 * page — the only place to exercise the erasure the consent screen promised
 * "at any time" — once they closed the tab.
 */
describe('the completion email', () => {
  let t: ReturnType<typeof newTest>
  let s: OpenSeed

  beforeEach(async () => {
    vi.stubEnv('SITE_URL', 'https://interw.test/')
    sent.length = 0
    t = newTest()
    s = await seedOpen(t)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const scheduled = () =>
    t.run((ctx) => ctx.db.system.query('_scheduled_functions').collect())

  it('is scheduled by finish, once', async () => {
    await t.mutation(api.interview.finish, { token: s.token })
    await t.mutation(api.interview.finish, { token: s.token })
    const jobs = (await scheduled()).filter((job) =>
      job.name.includes('sendCompletionEmail'),
    )
    expect(jobs).toHaveLength(1)
  })

  it('carries the link to the data page, in the role’s language', async () => {
    await t.mutation(internal.interview.sendCompletionEmail, {
      sessionId: s.sessionId,
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe('alex@example.test')
    expect(sent[0].text).toContain(`https://interw.test/s/${s.token}/privacy`)
    expect(sent[0].subject).toContain('envoyé')
    const logged = await t.run((ctx) =>
      ctx.db
        .query('emailLog')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
    expect(logged.map((row) => row.template)).toEqual(['candidate-completed'])
  })

  it('is not sent for a session erased in the meantime', async () => {
    await t.run((ctx) => ctx.db.delete('sessions', s.sessionId))
    await t.mutation(internal.interview.sendCompletionEmail, {
      sessionId: s.sessionId,
    })
    expect(sent).toHaveLength(0)
  })
})
