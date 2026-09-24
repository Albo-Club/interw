/**
 * From "the candidate pressed finish" to "the recruiter has a report".
 *
 *   session completed
 *      └─> transcribe(segment)          one job per answer, in parallel
 *             └─> when every answer is transcribed:
 *                    generateReport(session)
 *                       └─> notifyRecruiter(session)
 *
 * Three properties hold for every step, and they are why this codebase has no
 * catch-up scripts. The previous build had three of them, which mostly
 * documented that the normal path lost sessions.
 *
 *   Idempotent — each job checks at entry whether its result already exists.
 *     A replay is a no-op, so the pool may retry freely.
 *   Observable — every transition is written to `jobLog` with its duration and
 *     outcome, so "where did this session get stuck" is a query, not a guess.
 *   Self-healing — a failure is retried by the pool with backoff. If a step can
 *     fail, the queue picks it up again; nothing waits for a human to notice.
 */

import { ConvexError, v } from 'convex/values'

import { vOnCompleteValidator } from '@convex-dev/workpool'
import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import schema, { jobOutcomeValidator, jobStepValidator } from './schema'
import { complete, transcribe  } from './lib/ai'
import { getObjectStream } from './lib/objectStore'
import { reportPrompt } from './lib/prompts'
import { buildReport } from './lib/reportBuilder'
import { reportOutputSchema } from './lib/reportSchema'
import { normalizeWeights } from './lib/weights'
import { mediaPool, reportPool } from './lib/workpools'
import type { GenericMutationCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

/* ────────────────────────── Failure reporting ───────────────────────────── */

/**
 * The server-side half of "a step can fail is observable".
 *
 * `jobLog` records the transition for the product; this puts the same failure
 * where an operator actually looks. One named, structured line per failure, so
 * a Convex log search on `pipeline_step_failed` finds every one of them
 * without knowing which step to ask about.
 *
 * Not Sentry: the Convex side has no SDK wired up, and `CLAUDE.md`'s claim
 * that it does is one of the stale statements chantier 5 is to fix. A named
 * line is the honest version of the same thing until then.
 */
function logStepFailure(
  step: 'transcribe' | 'report' | 'notify',
  sessionId: Id<'sessions'>,
  error: unknown,
): void {
  console.error(
    'pipeline_step_failed ' +
      JSON.stringify({
        step,
        sessionId,
        message: error instanceof Error ? error.message : String(error),
      }),
  )
}

/* ─────────────────────────────── Job log ────────────────────────────────── */

/**
 * Which real attempt at `step` (for one answer, when it is a transcription)
 * a new row belongs to: one per `started` row already in the log.
 *
 * Counted here because the work pool does not hand its attempt number to the
 * job it runs. Relaunches count too, which is the useful figure anyway — it
 * is how many times this step was actually paid for.
 */
async function attemptNumber(
  ctx: GenericMutationCtx<DataModel>,
  row: Pick<Doc<'jobLog'>, 'sessionId' | 'step' | 'segmentId' | 'outcome'>,
): Promise<number> {
  const started = await ctx.db
    .query('jobLog')
    .withIndex('by_attempt', (q) =>
      q
        .eq('sessionId', row.sessionId)
        .eq('step', row.step)
        .eq('segmentId', row.segmentId)
        .eq('outcome', 'started'),
    )
    .collect()
  return row.outcome === 'started'
    ? started.length + 1
    : Math.max(started.length, 1)
}

export const recordJob = internalMutation({
  args: {
    sessionId: v.id('sessions'),
    step: jobStepValidator,
    outcome: jobOutcomeValidator,
    segmentId: v.optional(v.id('segments')),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
    audioSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId)
    if (!session) return null
    await ctx.db.insert('jobLog', {
      ...args,
      orgId: session.orgId,
      attempt: await attemptNumber(ctx, args),
      error: args.error?.slice(0, 1_000),
      at: Date.now(),
    })
    return null
  },
})

/* ───────────────────────────── Entry point ─────────────────────────────── */

export const onSessionCompleted = internalMutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return null
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const uploaded = segments.filter((s) => s.uploadState === 'uploaded')

    // Nothing was recorded: there is no report to make, and saying so in the
    // log is more useful than a job that fails four times on empty input.
    if (uploaded.length === 0) {
      await ctx.db.insert('jobLog', {
        orgId: session.orgId,
        sessionId,
        step: 'transcribe',
        outcome: 'skipped',
        attempt: 1,
        error: 'no_recordings',
        at: Date.now(),
      })
      return null
    }

    // Re-entrant on purpose: this also runs when an operator relaunches a
    // stuck session. An answer that already has a transcript keeps it and
    // counts as settled; one that failed for good goes back to `pending` and
    // gets another real attempt, which is the whole point of relaunching.
    let settled = 0
    const toEnqueue: Array<Id<'segments'>> = []
    for (const segment of uploaded) {
      if (segment.transcriptionState === 'done') {
        settled += 1
        continue
      }
      await ctx.db.patch('segments', segment._id, {
        transcriptionState: 'pending',
      })
      toEnqueue.push(segment._id)
    }

    await ctx.db.patch('sessions', sessionId, {
      segmentsExpected: uploaded.length,
      segmentsSettled: settled,
      reportJobEnqueuedAt: undefined,
    })

    for (const segmentId of toEnqueue) {
      await mediaPool.enqueueAction(
        ctx,
        internal.pipeline.transcribeSegment,
        { segmentId },
        {
          onComplete: internal.pipeline.onTranscribeComplete,
          context: { sessionId, segmentId },
        },
      )
    }

    // Everything was already transcribed — a relaunch after the report step
    // failed. Nothing will settle, so the gate has to be asked here.
    if (toEnqueue.length === 0) await enqueueReportIfSettled(ctx, sessionId)
    return null
  },
})

/* ──────────────────────────── Transcription ────────────────────────────── */

export const segmentForTranscription = internalQuery({
  args: { segmentId: v.id('segments') },
  handler: async (ctx, { segmentId }) => {
    const segment = await ctx.db.get('segments', segmentId)
    if (!segment) return null
    const existing = await ctx.db
      .query('transcripts')
      .withIndex('by_segment', (q) => q.eq('segmentId', segmentId))
      .unique()
    const session = await ctx.db.get('sessions', segment.sessionId)
    const project = session
      ? await ctx.db.get('projects', session.projectId)
      : null
    return {
      sessionId: segment.sessionId,
      orgId: segment.orgId,
      audioKey: segment.audioKey ?? null,
      videoKey: segment.videoKey ?? null,
      alreadyTranscribed: existing !== null,
      language: project?.language ?? 'fr',
    }
  },
})

export const saveTranscript = internalMutation({
  args: {
    segmentId: v.id('segments'),
    text: v.string(),
    words: v.array(
      v.object({ start: v.number(), end: v.number(), text: v.string() }),
    ),
    model: v.string(),
    /** The provider's own measure of the audio it transcribed. */
    audioSeconds: v.optional(v.number()),
  },
  handler: async (ctx, { segmentId, text, words, model, audioSeconds }) => {
    const segment = await ctx.db.get('segments', segmentId)
    if (!segment) throw new ConvexError('not_found')
    const existing = await ctx.db
      .query('transcripts')
      .withIndex('by_segment', (q) => q.eq('segmentId', segmentId))
      .unique()
    if (existing) return null
    await ctx.db.insert('transcripts', {
      orgId: segment.orgId,
      sessionId: segment.sessionId,
      segmentId,
      text,
      words,
      model,
      createdAt: Date.now(),
    })
    // The answer's length, as the server observed it. The candidate's browser
    // reports one too, and the report must not be computed from a number the
    // assessed person chose. The provider's measure first; else the end of
    // the last timed word; else nothing, rather than a guess.
    const measuredSeconds =
      audioSeconds !== undefined &&
      Number.isFinite(audioSeconds) &&
      audioSeconds > 0
        ? audioSeconds
        : words.reduce((last, word) => Math.max(last, word.end), 0)
    if (measuredSeconds > 0) {
      await ctx.db.patch('segments', segmentId, { measuredSeconds })
    }
    return null
  },
})

export const transcribeSegment = internalAction({
  args: { segmentId: v.id('segments') },
  handler: async (ctx, { segmentId }): Promise<null> => {
    const started = Date.now()
    const context = await ctx.runQuery(
      internal.pipeline.segmentForTranscription,
      { segmentId },
    )
    if (!context) return null

    // Idempotence: a retry, or a replay of the whole chain, must not produce
    // a second transcript or a second provider bill.
    if (context.alreadyTranscribed) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId: context.sessionId,
        step: 'transcribe',
        segmentId,
        outcome: 'skipped',
      })
      return null
    }

    await ctx.runMutation(internal.pipeline.recordJob, {
      sessionId: context.sessionId,
      step: 'transcribe',
      segmentId,
      outcome: 'started',
    })

    try {
      // Prefer the audio-only track: it is what the provider expects, and a
      // video container is both larger and often refused.
      const key = context.audioKey ?? context.videoKey
      if (!key) throw new ConvexError('segment_has_no_media')
      const stream = await getObjectStream(key)
      const result = await transcribe(stream, {
        language: context.language,
        fileName: key.split('/').pop() ?? 'answer',
        contentType: context.audioKey ? 'audio/webm' : 'video/webm',
      })
      await ctx.runMutation(internal.pipeline.saveTranscript, {
        segmentId,
        text: result.text,
        words: result.words,
        model: result.model,
        audioSeconds: result.audioSeconds ?? undefined,
      })
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId: context.sessionId,
        step: 'transcribe',
        segmentId,
        outcome: 'succeeded',
        durationMs: Date.now() - started,
        audioSeconds: result.audioSeconds ?? undefined,
      })
    } catch (error) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId: context.sessionId,
        step: 'transcribe',
        segmentId,
        outcome: 'failed',
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      logStepFailure('transcribe', context.sessionId, error)
      // Rethrow so the pool retries with backoff. Swallowing here is exactly
      // how the previous build lost sessions quietly.
      throw error
    }
    return null
  },
})

/**
 * The fan-in, as a state transition rather than a reconstruction.
 *
 * Called at most once per answer, by the pool, when that answer's job has
 * reached a terminal state — after every retry it was going to get. Both
 * outcomes settle it: the count is of answers that will not change again, not
 * of answers that worked.
 *
 * Every path through here reads and writes the `sessions` row, so two answers
 * landing in the same instant are serialised by Convex's OCC. Exactly one of
 * them sees the count complete, and it claims the report job in that same
 * transaction.
 */
export const onTranscribeComplete = internalMutation({
  // The component's own validator, rather than a hand-written one: `workId`
  // is a branded string and `result` a union, and getting either subtly wrong
  // fails at dispatch time, in a queue, where nobody is watching.
  args: vOnCompleteValidator(
    v.object({ sessionId: v.id('sessions'), segmentId: v.id('segments') }),
  ),
  handler: async (ctx, { context, result }): Promise<null> => {
    const { sessionId, segmentId } = context
    // A cancellation settles the answer too. Leaving it unsettled would put
    // the session back in the state this whole mechanism exists to remove:
    // waiting for something that is never coming.
    const outcome = result.kind === 'success' ? 'done' : 'failed'
    const error =
      result.kind === 'failed'
        ? result.error
        : result.kind === 'canceled'
          ? 'canceled'
          : undefined

    const segment = await ctx.db.get('segments', segmentId)
    if (!segment || segment.sessionId !== sessionId) return null
    // Idempotent per answer: an answer already settled does not settle twice,
    // whatever the pool replays.
    if (
      segment.transcriptionState === 'done' ||
      segment.transcriptionState === 'failed'
    ) {
      return null
    }

    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return null

    await ctx.db.patch('segments', segmentId, { transcriptionState: outcome })
    await ctx.db.patch('sessions', sessionId, {
      segmentsSettled: (session.segmentsSettled ?? 0) + 1,
    })

    if (outcome === 'failed') {
      // Distinct from the per-attempt `transcribe/failed` rows the action
      // writes: this one says the answer is gone for good.
      await ctx.db.insert('jobLog', {
        orgId: session.orgId,
        sessionId,
        step: 'transcribe',
        segmentId,
        outcome: 'failed',
        attempt: await attemptNumber(ctx, {
          sessionId,
          step: 'transcribe',
          segmentId,
          outcome: 'failed',
        }),
        error: `terminal: ${(error ?? 'unknown').slice(0, 900)}`,
        at: Date.now(),
      })
      logStepFailure('transcribe', sessionId, `terminal: ${error ?? 'unknown'}`)
    }

    await enqueueReportIfSettled(ctx, sessionId)
    return null
  },
})

/**
 * Put the report on the queue if, and only if, every answer has settled and
 * nobody has claimed it yet.
 *
 * The claim (`reportJobEnqueuedAt`) is patched in the same transaction as the
 * enqueue. Before it existed, deduplication read the `reports` table — which
 * `generateReport` only writes thirty to sixty seconds later — so in the
 * ordinary case where the last two answers land together, both callers saw an
 * empty table and both queued a job. Two deep-model calls per interview, in
 * the nominal path.
 */
async function enqueueReportIfSettled(
  ctx: GenericMutationCtx<DataModel>,
  sessionId: Id<'sessions'>,
): Promise<void> {
  const session = await ctx.db.get('sessions', sessionId)
  if (!session) return
  const expected = session.segmentsExpected ?? 0
  if (expected === 0) return
  if ((session.segmentsSettled ?? 0) < expected) return
  if (session.reportJobEnqueuedAt !== undefined) return

  const report = await ctx.db
    .query('reports')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .unique()
  if (report) return

  await ctx.db.patch('sessions', sessionId, {
    reportJobEnqueuedAt: Date.now(),
  })
  await reportPool.enqueueAction(
    ctx,
    internal.pipeline.generateReport,
    { sessionId },
    {
      onComplete: internal.pipeline.onReportComplete,
      context: { sessionId },
    },
  )
}

/* ────────────────────────────── The report ─────────────────────────────── */

export const reportInputs = internalQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return null
    const existing = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (existing) return { alreadyGenerated: true as const }

    const project = await ctx.db.get('projects', session.projectId)
    if (!project) return null
    const criteria = await ctx.db
      .query('criteria')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    const questions = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const transcripts = await ctx.db
      .query('transcripts')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const bySegment = new Map(transcripts.map((t) => [t.segmentId, t]))
    // By id, not by index. `orderIndex` is a display order and it is
    // renumbered when the trame is edited; `questionId` is an identity and it
    // is not. Joining on the order made every stored answer shift one question
    // along the day someone deleted question 2 — in reports already written as
    // much as in new ones, and the result did not look wrong.
    const byQuestionId = new Map(questions.map((q) => [q._id, q]))

    const uploaded = segments.filter(
      (segment) => segment.uploadState === 'uploaded',
    )
    // An answer with no transcript is not a silent zero: it is left out of
    // the report, and the report says it is missing one. Feeding the model an
    // empty transcript under a real question would have it score an answer
    // nobody heard.
    const answers = uploaded
      .filter((segment) => bySegment.has(segment._id))
      .sort((a, b) => a.questionIndex - b.questionIndex)
      .map((segment) => {
        const transcript = bySegment.get(segment._id)
        const question = byQuestionId.get(segment.questionId)
        return {
          segmentId: segment._id,
          questionId: segment.questionId,
          questionIndex: segment.questionIndex,
          // What the server measured, never the client's `durationSeconds`.
          durationSeconds: segment.measuredSeconds ?? null,
          question: question?.content ?? '',
          text: transcript?.text ?? '',
          chunks: transcript?.words ?? [],
        }
      })

    return {
      alreadyGenerated: false as const,
      orgId: session.orgId,
      /** How many answers were recorded but could not be read. */
      missingAnswers: uploaded.length - answers.length,
      language: project.language,
      jobTitle: project.jobTitle ?? project.title,
      criteria: normalizeWeights(
        criteria.map((criterion) => ({
          _id: criterion._id,
          label: criterion.label,
          description: criterion.description ?? null,
          weight: criterion.weight,
        })),
      ),
      answers,
    }
  },
})

export const saveReport = internalMutation({
  args: {
    sessionId: v.id('sessions'),
    // What `buildReport` produces, derived from the table so the two cannot
    // drift. The fields this mutation owns are left out, so a report can
    // never carry its own `orgId` past the spread below. `paraverbal` is
    // left out too: it is retired, and nothing may write it again.
    report: schema.tables.reports.validator.omit(
      'orgId',
      'sessionId',
      'partial',
      'paraverbal',
      'model',
      'generatedAt',
    ),
    model: v.string(),
    partial: v.boolean(),
  },
  handler: async (ctx, { sessionId, report, model, partial }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const existing = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (existing) return null

    await ctx.db.insert('reports', {
      orgId: session.orgId,
      sessionId,
      ...report,
      partial,
      model,
      generatedAt: Date.now(),
    })
    // Copied onto the session in the same transaction, once, by the queue.
    // The dashboard and the candidate table need the headline for every row
    // at once; reading `reports` per session made the dashboard a reactive
    // N+1 that re-ran on every candidate's upload.
    await ctx.db.patch('sessions', sessionId, {
      overallScore: report.overallScore,
      recommendation: report.recommendation,
    })
    return null
  },
})

export const generateReport = internalAction({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }): Promise<null> => {
    const started = Date.now()
    const inputs = await ctx.runQuery(internal.pipeline.reportInputs, {
      sessionId,
    })
    if (!inputs) return null
    if (inputs.alreadyGenerated) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'skipped',
      })
      return null
    }
    // A role with no criteria cannot be assessed and never could be: that is
    // a configuration gap, not a failure of this interview.
    if (inputs.criteria.length === 0) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'skipped',
        error: 'no_criteria',
      })
      return null
    }
    // Nothing readable came back from any answer. Recorded as a failure, not
    // a skip: an interview was sat and produced no assessment, and the
    // super-admin screen has to be able to count that.
    if (inputs.answers.length === 0) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'failed',
        error: 'no_transcribed_answers',
      })
      logStepFailure('report', sessionId, 'no_transcribed_answers')
      return null
    }

    await ctx.runMutation(internal.pipeline.recordJob, {
      sessionId,
      step: 'report',
      outcome: 'started',
    })

    try {
      const { system, user } = reportPrompt({
        language: inputs.language,
        jobTitle: inputs.jobTitle,
        criteria: inputs.criteria.map((criterion) => ({
          label: criterion.label,
          description: criterion.description,
          weight: criterion.normalizedWeight,
        })),
        answers: inputs.answers.map((answer) => ({
          question: answer.question,
          transcript: answer.text,
        })),
      })

      const { value, model, usage } = await complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        schema: reportOutputSchema,
        schemaName: 'interview_report',
        temperature: 0.2,
      })

      const built = buildReport({
        output: value,
        criteria: inputs.criteria,
        answers: inputs.answers,
      })

      await ctx.runMutation(internal.pipeline.saveReport, {
        sessionId,
        report: built,
        model,
        partial: inputs.missingAnswers > 0,
      })
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'succeeded',
        durationMs: Date.now() - started,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
        reasoningTokens: usage?.reasoningTokens,
        error:
          inputs.missingAnswers > 0
            ? `partial: ${inputs.missingAnswers} answer(s) unreadable`
            : undefined,
      })
    } catch (error) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'failed',
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      logStepFailure('report', sessionId, error)
      throw error
    }
    return null
  },
})

export const onReportComplete = internalMutation({
  args: vOnCompleteValidator(v.object({ sessionId: v.id('sessions') })),
  handler: async (ctx, { context }): Promise<null> => {
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', context.sessionId))
      .unique()
    if (!report) {
      // The job is over and produced nothing. Releasing the claim is what
      // lets an operator relaunch it — while the claim is held, a relaunch
      // is refused, because it would pay for a second completion.
      const session = await ctx.db.get('sessions', context.sessionId)
      if (session) {
        await ctx.db.patch('sessions', context.sessionId, {
          reportJobEnqueuedAt: undefined,
        })
      }
      return null
    }
    await reportPool.enqueueAction(
      ctx,
      internal.pipeline.notifyRecruiter,
      { sessionId: context.sessionId },
      { retry: true },
    )
    return null
  },
})

export const notifyRecruiter = internalAction({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }): Promise<null> => {
    const started = Date.now()
    try {
      const sent: boolean = await ctx.runMutation(
        internal.notifications.sendReportReady,
        { sessionId },
      )
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'notify',
        outcome: sent ? 'succeeded' : 'skipped',
        durationMs: Date.now() - started,
      })
    } catch (error) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'notify',
        outcome: 'failed',
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      logStepFailure('notify', sessionId, error)
      throw error
    }
    return null
  },
})
