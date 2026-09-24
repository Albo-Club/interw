/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'
import type { Doc, Id } from './_generated/dataModel'

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
    expect(after.scheduled).toHaveLength(1)
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
