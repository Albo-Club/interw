/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { register as registerResend } from '@convex-dev/resend/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/**
 * The two calls that leave the deployment, stood in for. `transcribe` fails
 * for one nominated answer and succeeds for the rest, which is the shape of
 * the incident this whole mechanism was built for: one codec the provider
 * refuses, six answers that are perfectly fine.
 */
const failingKeys = new Set<string>()

vi.mock('./lib/ai', () => ({
  transcribe: (
    _stream: unknown,
    options: { fileName: string },
  ): Promise<{
    text: string
    words: Array<{ start: number; end: number; text: string }>
    model: string
  }> => {
    if (failingKeys.has(options.fileName)) {
      return Promise.reject(new Error('provider refused this container'))
    }
    return Promise.resolve({
      text: 'Une réponse détaillée sur la migration.',
      words: [
        { start: 0, end: 4, text: 'Une réponse détaillée sur la migration.' },
      ],
      model: 'voxtral-stub',
    })
  },
  complete: (options: { messages: Array<{ role: string; content: string }> }) => {
    // The stub answers the shape the schema demands, sized to whatever set of
    // answers it was actually handed — which is the point of the partial case:
    // a report over six answers must be built from six, not seven.
    const answerCount = (
      options.messages[1]?.content.match(/### Answer /g) ?? []
    ).length
    return Promise.resolve({
      value: {
        verdictHeadline: 'Strong on delivery, thin on scale.',
        executiveSummary:
          'Alex led a database migration end to end and can describe the ' +
          'trade-offs they made, with specifics on rollback and timing.',
        overallScore: 71,
        recommendation: 'yes' as const,
        strengths: ['Led a migration end to end'],
        concerns: [],
        criteria: [
          {
            criterionIndex: 0,
            score: 71,
            level: 'solid' as const,
            rationale: 'Describes the migration with specifics.',
            evidence: [],
          },
        ],
        answers: Array.from({ length: answerCount }, (_, index) => ({
          answerIndex: index,
          score: 7,
          summary: 'Concrete, with an example.',
          depth: 'concrete' as const,
          evidence: null,
        })),
        highlights: [],
      },
      model: 'gemini-stub',
    })
  },
}))

/**
 * Sending, stood in for as well. What matters to this test is that exactly
 * one `report-ready` row is written, not that a provider accepted it.
 */
vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: {
    sendEmail: () => Promise.resolve('provider-id-stub'),
  },
}))

vi.mock('./lib/objectStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getObjectStream: () => Promise.resolve(new Blob(['audio'])),
  deleteObjects: () => Promise.resolve(),
  presignGet: () => Promise.resolve('https://example.test/signed'),
}))

const modules = import.meta.glob('./**/*.ts')

/**
 * `@convex-dev/workpool/test` is imported through a non-literal specifier so
 * `tsc` does not pull it into the program.
 *
 * The export points at the package's raw `src/test.ts`, which reaches
 * `src/component/shared.ts`, which has an unused local. Under this project's
 * `noUnusedLocals` that is an error in a file we do not own and cannot fix,
 * and it fails `pnpm typecheck` for the whole repo. Its two siblings
 * (`rate-limiter`, `resend`) ship the same shape and happen to be clean, so
 * they are imported normally. See KNOWN_ISSUES.md.
 */
const workpoolTest = '@convex-dev/workpool/test'
type RegisterComponent = (t: unknown, name: string) => void

async function newTest() {
  const t = convexTest(schema, modules)
  const { register } = (await import(/* @vite-ignore */ workpoolTest)) as {
    register: RegisterComponent
  }
  registerRateLimiter(t, 'rateLimiter')
  register(t, 'mediaWorkpool')
  register(t, 'reportWorkpool')
  registerResend(t, 'resend')
  return t
}

const QUESTION_COUNT = 7
/** The answer whose transcription never succeeds. */
const DOOMED_INDEX = 3

type TestConvex = Awaited<ReturnType<typeof newTest>>
type Seed = { sessionId: Id<'sessions'>; orgId: Id<'organizations'> }

async function seed(t: TestConvex): Promise<Seed> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_1',
      email: 'recruiter@acme.test',
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
    await ctx.db.insert('criteria', {
      orgId,
      projectId,
      label: 'Delivery',
      weight: 100,
      orderIndex: 0,
    })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: 'q'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'completed',
      lastQuestionIndex: QUESTION_COUNT,
      invitedBy: userId,
      invitedAt: 0,
      completedAt: 1,
    })
    for (let i = 0; i < QUESTION_COUNT; i++) {
      const questionId = await ctx.db.insert('questions', {
        orgId,
        projectId,
        orderIndex: i,
        content: `Question ${i}?`,
        maxResponseSeconds: 120,
      })
      await ctx.db.insert('segments', {
        orgId,
        sessionId,
        questionId,
        questionIndex: i,
        audioKey: `orgs/o/sessions/s/q${i}.weba`,
        uploadState: 'uploaded',
        uploadAttempts: 1,
        recordedAt: 0,
      })
    }
    return { sessionId, orgId }
  })
}

/**
 * Run the queues to a standstill.
 *
 * Not `finishAllScheduledFunctions`: a Workpool keeps a supervisor loop that
 * reschedules itself for as long as the pool exists, so "all scheduled work
 * has finished" is a state it never reaches. Advancing the clock in bounded
 * steps drains the real jobs — including the pool's own retry backoff, which
 * is what makes a terminal failure terminal — and then stops.
 */
async function drain(t: TestConvex): Promise<void> {
  for (let i = 0; i < 60; i++) {
    await vi.advanceTimersByTimeAsync(30_000)
    await t.finishInProgressScheduledFunctions()
  }
}

/**
 * Before this, one answer that exhausted its retries froze the session for
 * good: the gate asked "does every answer have a transcript?", which nothing
 * would ever make true again, so there was no report, no email and no alert —
 * discovered, if ever, by a recruiter wondering where a candidate went. And in
 * the ordinary case where the last two answers landed together, both callers
 * read an empty `reports` table and queued a job each: two deep-model bills
 * per interview.
 */
describe('the fan-in', () => {
  let t: TestConvex
  let s: Seed

  beforeEach(async () => {
    vi.useFakeTimers()
    failingKeys.clear()
    t = await newTest()
    s = await seed(t)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('still reaches a report when one answer fails for good', async () => {
    failingKeys.add(`q${DOOMED_INDEX}.weba`)

    await t.mutation(internal.pipeline.onSessionCompleted, {
      sessionId: s.sessionId,
    })
    await drain(t)

    const { reports, segments, session, emails } = await t.run(async (ctx) => ({
      reports: await ctx.db
        .query('reports')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
      segments: await ctx.db
        .query('segments')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
      session: await ctx.db.get('sessions', s.sessionId),
      emails: await ctx.db
        .query('emailLog')
        .withIndex('by_org_and_created', (q) => q.eq('orgId', s.orgId))
        .collect(),
    }))

    // One report, not two: the claim is taken in the same transaction as the
    // enqueue, so only one of the settling answers queues the job.
    expect(reports).toHaveLength(1)
    // And it says it is missing an answer rather than presenting six as seven.
    expect(reports[0].partial).toBe(true)

    // The failure is a state, not an absence.
    const doomed = segments.find((seg) => seg.questionIndex === DOOMED_INDEX)
    expect(doomed?.transcriptionState).toBe('failed')
    expect(
      segments.filter((seg) => seg.transcriptionState === 'done'),
    ).toHaveLength(QUESTION_COUNT - 1)

    // Every answer settled, so the gate completed.
    expect(session?.segmentsExpected).toBe(QUESTION_COUNT)
    expect(session?.segmentsSettled).toBe(QUESTION_COUNT)
    expect(session?.reportJobEnqueuedAt).toEqual(expect.any(Number))

    expect(
      emails.filter((entry) => entry.template === 'report-ready'),
    ).toHaveLength(1)
  })

  it('queues exactly one report job when every answer succeeds', async () => {
    await t.mutation(internal.pipeline.onSessionCompleted, {
      sessionId: s.sessionId,
    })
    await drain(t)

    const { reports, started, emails } = await t.run(async (ctx) => {
      const jobs = await ctx.db
        .query('jobLog')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect()
      return {
        reports: await ctx.db
          .query('reports')
          .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
          .collect(),
        started: jobs.filter(
          (job) => job.step === 'report' && job.outcome === 'started',
        ),
        emails: await ctx.db
          .query('emailLog')
          .withIndex('by_org_and_created', (q) => q.eq('orgId', s.orgId))
          .collect(),
      }
    })

    expect(reports).toHaveLength(1)
    expect(reports[0].partial).toBe(false)
    // One provider call for one interview. `convex-test` serialises
    // mutations, so it cannot stage the interleaving that used to queue two
    // jobs — what this pins is that the settled path enqueues exactly once,
    // which is the invariant the claim token exists to keep under real
    // concurrency.
    expect(started).toHaveLength(1)
    expect(
      emails.filter((entry) => entry.template === 'report-ready'),
    ).toHaveLength(1)
  })

  it('records a failed report and no email when nothing is readable', async () => {
    for (let i = 0; i < QUESTION_COUNT; i++) failingKeys.add(`q${i}.weba`)

    await t.mutation(internal.pipeline.onSessionCompleted, {
      sessionId: s.sessionId,
    })
    await drain(t)

    const { reports, failures, emails } = await t.run(async (ctx) => {
      const jobs = await ctx.db
        .query('jobLog')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect()
      return {
        reports: await ctx.db
          .query('reports')
          .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
          .collect(),
        failures: jobs.filter(
          (job) => job.step === 'report' && job.outcome === 'failed',
        ),
        emails: await ctx.db
          .query('emailLog')
          .withIndex('by_org_and_created', (q) => q.eq('orgId', s.orgId))
          .collect(),
      }
    })

    // Nothing to assess, so nothing is invented — but it is written down as a
    // failure, which is what the super-admin screen counts.
    expect(reports).toHaveLength(0)
    expect(failures.length).toBeGreaterThanOrEqual(1)
    expect(failures[0].error).toBe('no_transcribed_answers')
    expect(emails).toHaveLength(0)
  })
})
