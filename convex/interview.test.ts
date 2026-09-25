/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import { segmentKey } from './lib/objectStore'
import schema from './schema'
import type { Doc, Id } from './_generated/dataModel'

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

/** The same seed, as a live role with an interview under way. */
async function seedStarted(t: ReturnType<typeof newTest>) {
  const s = await seed(t)
  const ids = await t.run(async (ctx) => {
    await ctx.db.patch('projects', s.projectId, { expiresAt: undefined })
    const session = (await ctx.db
      .query('sessions')
      .withIndex('by_token', (q) => q.eq('accessToken', s.token))
      .unique())!
    await ctx.db.patch('sessions', session._id, {
      status: 'in_progress',
      startedAt: 1,
    })
    const question = (await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', s.projectId))
      .unique())!
    const segmentId = await ctx.db.insert('segments', {
      orgId: session.orgId,
      sessionId: session._id,
      questionId: question._id,
      questionIndex: 0,
      audioKey: 'orgs/o/sessions/s/q0.weba',
      uploadState: 'uploaded',
      uploadAttempts: 1,
      recordedAt: 1,
    })
    return { sessionId: session._id, segmentId }
  })
  return { ...s, ...ids }
}

/**
 * Audit 2026-09-22, `convex/interview.ts:finish:bypasses-session-gate`.
 *
 * `finish` resolved the token and nothing else, so a link the recruiter had
 * cancelled — or a role they had archived — could still complete the
 * interview: status flipped to completed, retention reset, counter bumped,
 * and the paid pipeline started on whatever had been uploaded.
 */
describe('finish honours the session gate', () => {
  let t: ReturnType<typeof newTest>
  let s: Awaited<ReturnType<typeof seedStarted>>

  beforeEach(async () => {
    t = newTest()
    s = await seedStarted(t)
  })

  async function snapshot() {
    return await t.run(async (ctx) => ({
      session: await ctx.db.get('sessions', s.sessionId),
      project: await ctx.db.get('projects', s.projectId),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }))
  }

  const refusals: Array<{
    name: string
    code: string
    session?: Partial<Doc<'sessions'>>
    project?: Partial<Doc<'projects'>>
  }> = [
    {
      name: 'a cancelled link',
      code: 'cancelled',
      session: { status: 'cancelled' },
    },
    {
      name: 'an archived role',
      code: 'closed',
      project: { status: 'archived' },
    },
    { name: 'a draft role', code: 'closed', project: { status: 'draft' } },
    {
      name: 'a session that itself expired',
      code: 'expired',
      session: { status: 'expired' },
    },
    {
      name: 'an interview that never started',
      code: 'not_started',
      session: { status: 'pending' },
    },
    {
      name: 'an interview without consent',
      code: 'not_started',
      session: { consentAcceptedAt: undefined },
    },
  ]

  for (const refusal of refusals) {
    it(`refuses ${refusal.name}, and changes nothing`, async () => {
      await t.run(async (ctx) => {
        if (refusal.session) {
          await ctx.db.patch('sessions', s.sessionId, refusal.session)
        }
        if (refusal.project) {
          await ctx.db.patch('projects', s.projectId, refusal.project)
        }
      })
      const before = await snapshot()

      await expect(
        t.mutation(api.interview.finish, { token: s.token }),
      ).rejects.toThrow(refusal.code)

      const after = await snapshot()
      expect(after.session).toEqual(before.session)
      expect(after.project!.completedSessionCount).toBe(0)
      expect(after.scheduled).toEqual([])
    })
  }

  it("still finishes when only the role's deadline has passed", async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('projects', s.projectId, { expiresAt: 1_000 })
    })
    await expect(
      t.mutation(api.interview.finish, { token: s.token }),
    ).resolves.toEqual({ alreadyCompleted: false })

    const after = await snapshot()
    expect(after.session!.status).toBe('completed')
    expect(after.project!.completedSessionCount).toBe(1)
    // The pipeline, and the candidate's confirmation email.
    expect(after.scheduled.map((job) => job.name).sort()).toEqual([
      'interview:sendCompletionEmail',
      'pipeline:onSessionCompleted',
    ])
  })
})

/**
 * Audit 2026-09-22, `convex/interview.ts:markSegmentFailed:sessionEvents-uncapped`.
 *
 * The cap on `sessionEvents` lived inside `logEvent` alone, so the other
 * token-gated writers grew the table without bound — and the cap itself, a
 * negative `slice` bound, settled near half of what it claimed.
 */
describe('sessionEvents stays capped per session', () => {
  const CAP = 200
  let t: ReturnType<typeof newTest>
  let s: Awaited<ReturnType<typeof seedStarted>>

  beforeEach(async () => {
    t = newTest()
    s = await seedStarted(t)
  })

  async function fill(count: number) {
    await t.run(async (ctx) => {
      const session = (await ctx.db.get('sessions', s.sessionId))!
      for (let i = 0; i < count; i++) {
        await ctx.db.insert('sessionEvents', {
          orgId: session.orgId,
          sessionId: session._id,
          kind: 'upload_retried',
          at: i,
        })
      }
    })
  }

  async function events() {
    return await t.run(async (ctx) =>
      ctx.db
        .query('sessionEvents')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
  }

  const writers = {
    logEvent: () =>
      t.mutation(api.interview.logEvent, {
        token: s.token,
        kind: 'network_degraded',
        detail: 'x'.repeat(2_000),
      }),
    markSegmentFailed: () =>
      t.mutation(api.interview.markSegmentFailed, {
        token: s.token,
        segmentId: s.segmentId,
        detail: 'y'.repeat(2_000),
      }),
    start: () => t.mutation(api.interview.start, { token: s.token }),
  }

  for (const [name, write] of Object.entries(writers)) {
    it(`${name} never takes a session past the cap`, async () => {
      await fill(CAP)
      for (let i = 0; i < 5; i++) {
        await write()
        expect(await events()).toHaveLength(CAP)
      }
    })
  }

  it('acceptConsent never takes a session past the cap', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', s.sessionId, {
        status: 'pending',
        consentAcceptedAt: undefined,
      })
    })
    await fill(CAP)
    await t.mutation(api.candidate.acceptConsent, { token: s.token })
    expect(await events()).toHaveLength(CAP)
  })

  it('keeps every event while under the cap', async () => {
    await fill(150)
    await writers.logEvent()
    expect(await events()).toHaveLength(151)
  })

  it('drops the oldest events, not the newest', async () => {
    await fill(CAP)
    await writers.logEvent()
    const kept = await events()
    expect(kept[0].at).toBe(1)
    expect(kept.at(-1)!.kind).toBe('network_degraded')
    expect(kept.at(-1)!.detail).toHaveLength(500)
  })
})

/**
 * Audit 2026-09-22,
 * `convex/pipeline.ts:reportInputs:candidate-reported-durationSeconds-in-report`.
 *
 * The report no longer reads the client's number (see pipeline.test.ts), and
 * even as a display hint it stays within what the recorder could produce.
 */
describe('markSegmentUploaded bounds the reported duration', () => {
  let t: ReturnType<typeof newTest>
  let s: Awaited<ReturnType<typeof seedStarted>>

  beforeEach(async () => {
    t = newTest()
    s = await seedStarted(t)
  })

  async function stored() {
    const segment = await t.run(async (ctx) =>
      ctx.db.get('segments', s.segmentId),
    )
    return segment!.durationSeconds ?? null
  }

  it("clamps to the question's limit plus a margin", async () => {
    await t.mutation(api.interview.markSegmentUploaded, {
      token: s.token,
      segmentId: s.segmentId,
      durationSeconds: 100_000,
    })
    expect(await stored()).toBe(125)

    await t.mutation(api.interview.markSegmentUploaded, {
      token: s.token,
      segmentId: s.segmentId,
      durationSeconds: -3,
    })
    expect(await stored()).toBe(0)
  })

  it('refuses a duration that is not a finite number', async () => {
    for (const durationSeconds of [NaN, Infinity]) {
      await expect(
        t.mutation(api.interview.markSegmentUploaded, {
          token: s.token,
          segmentId: s.segmentId,
          durationSeconds,
        }),
      ).rejects.toThrow('invalid_duration')
    }
    expect(await stored()).toBeNull()
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
 * h01/h02, h09. Every answer could weigh 300 MB whatever the question's time
 * limit — and a paid transcription reads the whole object into memory — and
 * its PUT URL stayed valid for 15 minutes, well past `finish`, a cancellation
 * or an erasure.
 */
describe('an answer slot is sized by its question', () => {
  let t: ReturnType<typeof newTest>
  let s: OpenSeed
  const MB = 1024 * 1024

  beforeEach(async () => {
    vi.stubEnv('OBJECT_STORE_ENDPOINT', 'https://s3.example.test')
    vi.stubEnv('OBJECT_STORE_REGION', 'fr-par')
    vi.stubEnv('OBJECT_STORE_BUCKET', 'media')
    vi.stubEnv('OBJECT_STORE_ACCESS_KEY_ID', 'test-access-key')
    vi.stubEnv('OBJECT_STORE_SECRET_ACCESS_KEY', 'test-secret-key')
    t = newTest()
    s = await seedOpen(t)
    await t.run(async (ctx) => {
      await ctx.db.patch('questions', s.questionIds[0], {
        maxResponseSeconds: 60,
      })
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const reserve = (audioBytes: number, videoBytes?: number) =>
    t.mutation(internal.interview.reserveSegment, {
      token: s.token,
      questionIndex: 0,
      audio: { mimeType: 'audio/webm', contentLength: audioBytes },
      video:
        videoBytes === undefined
          ? undefined
          : { mimeType: 'video/webm', contentLength: videoBytes },
    })

  it('refuses a video no 60-second answer could produce', async () => {
    await expect(reserve(1_000, 100 * MB)).rejects.toThrow('media_too_large')
    await expect(reserve(10 * MB)).rejects.toThrow('media_too_large')
  })

  it('still takes several times what the recorder asks for', async () => {
    // 60 s at 1 Mbit/s is ~7.5 MB of video and ~0.5 MB of audio.
    const slot = await reserve(2 * MB, 30 * MB)
    expect(slot.status).toBe('reserved')
  })

  it('signs the PUT for the answer’s length plus a margin, not 15 minutes', async () => {
    const slot = await t.action(api.interview.requestSegmentUpload, {
      token: s.token,
      questionIndex: 0,
      audio: { mimeType: 'audio/webm', contentLength: 1_000 },
      video: { mimeType: 'video/webm', contentLength: 2_000 },
    })
    if (slot.status !== 'reserved') throw new Error('expected a slot')
    for (const url of [slot.audio.uploadUrl, slot.video!.uploadUrl]) {
      expect(new URL(url).searchParams.get('X-Amz-Expires')).toBe(
        String(60 + 3 * 60),
      )
    }
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

// Cand M12: leaving mid-answer disposed the recorder and told no one.
describe('an answer abandoned on the page', () => {
  it('is recorded in the session journal', async () => {
    const t = newTest()
    const s = await seedStarted(t)
    await t.mutation(api.interview.logEvent, {
      token: s.token,
      kind: 'recording_abandoned',
      detail: 'unsent',
    })
    const events = await t.run((ctx) =>
      ctx.db
        .query('sessionEvents')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
    expect(events.at(-1)).toMatchObject({
      kind: 'recording_abandoned',
      detail: 'unsent',
    })
  })
})
