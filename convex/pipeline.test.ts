/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'
import { chooseStartSeconds } from './lib/evidence'
import { computeParaverbal } from './lib/paraverbal'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  return convexTest(schema, modules)
}

type Seed = {
  sessionId: Id<'sessions'>
  segmentId: Id<'segments'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<Seed> {
  return await t.run(async (ctx) => {
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
      accessToken: 'q'.repeat(43),
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
      uploadState: 'uploaded',
      uploadAttempts: 1,
      recordedAt: 0,
    })
    return { sessionId, segmentId }
  })
}

const REPORT = {
  overallScore: 71,
  recommendation: 'yes' as const,
  executiveSummary: 'Solid.',
  criteriaScores: [],
  strengths: ['Led a migration'],
  concerns: [],
}

/**
 * The pipeline's central claim is that any step can be replayed without
 * changing the outcome — it is what lets the pool retry freely, and it is why
 * this codebase has no catch-up scripts. These tests hold it to that.
 */
describe('pipeline idempotency', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('writes one transcript however many times it is replayed', async () => {
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.pipeline.saveTranscript, {
        segmentId: s.segmentId,
        text: 'Une réponse.',
        words: [{ start: 0, end: 2, text: 'Une réponse.' }],
        model: 'voxtral-mini-latest',
      })
    }
    const transcripts = await t.run(async (ctx) =>
      ctx.db
        .query('transcripts')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
    expect(transcripts).toHaveLength(1)
  })

  it('keeps the first transcript rather than overwriting it on replay', async () => {
    await t.mutation(internal.pipeline.saveTranscript, {
      segmentId: s.segmentId,
      text: 'The real answer.',
      words: [],
      model: 'voxtral-mini-latest',
    })
    await t.mutation(internal.pipeline.saveTranscript, {
      segmentId: s.segmentId,
      text: 'A later, different answer.',
      words: [],
      model: 'voxtral-mini-latest',
    })
    const transcripts = await t.run(async (ctx) =>
      ctx.db
        .query('transcripts')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
    expect(transcripts).toHaveLength(1)
    expect(transcripts[0].text).toBe('The real answer.')
  })

  it('writes one report however many times it is replayed', async () => {
    for (let i = 0; i < 3; i++) {
      await t.mutation(internal.pipeline.saveReport, {
        sessionId: s.sessionId,
        report: REPORT,
        paraverbal: null,
        partial: false,
        model: 'test-model',
      })
    }
    const reports = await t.run(async (ctx) =>
      ctx.db
        .query('reports')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
    expect(reports).toHaveLength(1)
    expect(reports[0].overallScore).toBe(71)
  })

  // "Where did this session get stuck?" has to be a query, not a guess.
  it('records every transition with its step and outcome', async () => {
    for (const outcome of ['started', 'succeeded'] as const) {
      await t.mutation(internal.pipeline.recordJob, {
        sessionId: s.sessionId,
        step: 'transcribe',
        outcome,
        durationMs: 1200,
      })
    }
    const log = await t.run(async (ctx) =>
      ctx.db
        .query('jobLog')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
    )
    expect(log.map((entry) => entry.outcome)).toEqual(['started', 'succeeded'])
    expect(log[0].step).toBe('transcribe')
  })

  it('does not fail when the session it is logging against is gone', async () => {
    await t.run(async (ctx) => ctx.db.delete('sessions', s.sessionId))
    await expect(
      t.mutation(internal.pipeline.recordJob, {
        sessionId: s.sessionId,
        step: 'report',
        outcome: 'failed',
        error: 'boom',
      }),
    ).resolves.toBeNull()
  })
})

/**
 * Audit 2026-09-22,
 * `convex/pipeline.ts:reportInputs:candidate-reported-durationSeconds-in-report`.
 *
 * The answer length behind the para-verbal measures and every quote anchor
 * was the number the candidate's browser reported. It is now what the server
 * observed at transcription, so the report cannot move with the argument.
 */
describe('the answer length the report measures', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  // Two timed chunks over eight seconds, under a 120-second limit.
  const words = [
    { start: 0, end: 3.9, text: 'We migrated the billing service' },
    { start: 4.1, end: 8, text: 'and cut the release cycle from two weeks' },
  ]

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  async function inputsFor(clientSeconds: number) {
    await t.run(async (ctx) => {
      await ctx.db.patch('segments', s.segmentId, {
        durationSeconds: clientSeconds,
      })
    })
    const inputs = await t.query(internal.pipeline.reportInputs, {
      sessionId: s.sessionId,
    })
    if (!inputs || inputs.alreadyGenerated) throw new Error('no inputs')
    const answer = inputs.answers[0]
    return {
      durationSeconds: answer.durationSeconds,
      paraverbal: computeParaverbal(
        inputs.answers.map((a) => ({
          chunks: a.chunks,
          durationSeconds: a.durationSeconds ?? 0,
          maxResponseSeconds: a.maxResponseSeconds,
        })),
      ),
      anchor: chooseStartSeconds({
        chunks: answer.chunks,
        quote: 'cut the release cycle from two weeks',
        durationSeconds: answer.durationSeconds,
      }),
    }
  }

  it("does not move with the client's reported duration", async () => {
    await t.mutation(internal.pipeline.saveTranscript, {
      segmentId: s.segmentId,
      text: words.map((w) => w.text).join(' '),
      words,
      model: 'voxtral-mini-latest',
      audioSeconds: 9.5,
    })

    const results = [
      await inputsFor(8),
      await inputsFor(60),
      await inputsFor(1),
    ]
    expect(results[0].durationSeconds).toBe(9.5)
    expect(results[0].paraverbal).not.toBeNull()
    expect(results[0].anchor).toBe(4.1)
    expect(results[1]).toEqual(results[0])
    expect(results[2]).toEqual(results[0])
  })

  it('falls back to the end of the last timed word', async () => {
    await t.mutation(internal.pipeline.saveTranscript, {
      segmentId: s.segmentId,
      text: words.map((w) => w.text).join(' '),
      words,
      model: 'voxtral-mini-latest',
    })
    expect((await inputsFor(60)).durationSeconds).toBe(8)
  })

  it('is null, not the client number, when nothing was measured', async () => {
    await t.mutation(internal.pipeline.saveTranscript, {
      segmentId: s.segmentId,
      text: 'Une réponse.',
      words: [],
      model: 'voxtral-mini-latest',
    })
    const result = await inputsFor(60)
    expect(result.durationSeconds).toBeNull()
    // Left out of the delivery profile rather than measured against a guess.
    expect(result.paraverbal).toBeNull()
  })
})

describe('purge', () => {
  it('names every object of a session, including a failed upload', async () => {
    const t = newTest()
    const s = await seed(t)
    await t.run(async (ctx) => {
      const segment = (await ctx.db.get('segments', s.segmentId))!
      // A segment reserved, uploaded badly, and left failed. Its keys were
      // written before the upload — which is exactly why erasure can be exact.
      await ctx.db.insert('segments', {
        orgId: segment.orgId,
        sessionId: segment.sessionId,
        questionId: segment.questionId,
        questionIndex: 1,
        audioKey: 'orgs/o/sessions/s/q1.weba',
        videoKey: 'orgs/o/sessions/s/q1.webm',
        uploadState: 'failed',
        uploadAttempts: 3,
        recordedAt: 0,
      })
      await ctx.db.patch('sessions', s.sessionId, {
        cvKey: 'orgs/o/sessions/s/cv.pdf',
      })
    })

    const objects = await t.query(internal.purge.collectSessionObjects, {
      sessionId: s.sessionId,
    })
    expect(objects?.keys.sort()).toEqual([
      'orgs/o/sessions/s/cv.pdf',
      'orgs/o/sessions/s/q0.weba',
      'orgs/o/sessions/s/q1.weba',
      'orgs/o/sessions/s/q1.webm',
    ])
  })

  it('removes every row of a session and records the erasure', async () => {
    const t = newTest()
    const s = await seed(t)
    await t.mutation(internal.pipeline.saveReport, {
      sessionId: s.sessionId,
      report: REPORT,
      paraverbal: null,
      partial: false,
      model: 'test-model',
    })

    await t.mutation(internal.purge.deleteSessionRecords, {
      sessionId: s.sessionId,
      reason: 'candidate_request',
      candidateEmailHash: 'deadbeef',
      objectsDeleted: 4,
    })

    await t.run(async (ctx) => {
      expect(await ctx.db.get('sessions', s.sessionId)).toBeNull()
      expect(
        await ctx.db
          .query('segments')
          .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
          .collect(),
      ).toHaveLength(0)
      expect(
        await ctx.db
          .query('reports')
          .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
          .collect(),
      ).toHaveLength(0)
      const log = await ctx.db.query('purgeLog').collect()
      expect(log).toHaveLength(1)
      // A hash, never the address it records the destruction of.
      expect(log[0].candidateEmailHash).toBe('deadbeef')
      expect(JSON.stringify(log[0])).not.toContain('alex@example.test')
    })
  })

  it('is a no-op the second time, not an error', async () => {
    const t = newTest()
    const s = await seed(t)
    const erase = () =>
      t.mutation(internal.purge.deleteSessionRecords, {
        sessionId: s.sessionId,
        reason: 'retention',
        candidateEmailHash: 'deadbeef',
        objectsDeleted: 1,
      })
    await erase()
    await expect(erase()).resolves.toBeNull()
    const log = await t.run(async (ctx) => ctx.db.query('purgeLog').collect())
    expect(log).toHaveLength(1)
  })
})
