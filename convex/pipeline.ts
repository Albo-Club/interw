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
 *
 * Para-verbal analysis is computed inside `generateReport` rather than as the
 * parallel job the original design had. There it was a second model call; here
 * it is a deterministic computation over transcripts we already hold (see
 * lib/paraverbal.ts), so a separate job would add a failure mode and a partial
 * state for no gain at all.
 */

import { ConvexError, v } from 'convex/values'

import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { jobOutcomeValidator, jobStepValidator } from './schema'
import { complete, transcribe  } from './lib/ai'
import { getObjectStream } from './lib/objectStore'
import { computeParaverbal } from './lib/paraverbal'
import { reportPrompt } from './lib/prompts'
import { buildReport } from './lib/reportBuilder'
import { reportOutputSchema } from './lib/reportSchema'
import { normalizeWeights } from './lib/weights'
import { mediaPool, reportPool } from './lib/workpools'
import type { Id } from './_generated/dataModel'

/* ─────────────────────────────── Job log ────────────────────────────────── */

export const recordJob = internalMutation({
  args: {
    sessionId: v.id('sessions'),
    step: jobStepValidator,
    outcome: jobOutcomeValidator,
    attempt: v.optional(v.number()),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId)
    if (!session) return null
    await ctx.db.insert('jobLog', {
      orgId: session.orgId,
      sessionId: args.sessionId,
      step: args.step,
      outcome: args.outcome,
      attempt: args.attempt ?? 1,
      durationMs: args.durationMs,
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
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const uploaded = segments.filter((s) => s.uploadState === 'uploaded')

    // Nothing was recorded: there is no report to make, and saying so in the
    // log is more useful than a job that fails four times on empty input.
    if (uploaded.length === 0) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'transcribe',
        outcome: 'skipped',
        error: 'no_recordings',
      })
      return null
    }

    for (const segment of uploaded) {
      await mediaPool.enqueueAction(
        ctx,
        internal.pipeline.transcribeSegment,
        { segmentId: segment._id },
        {
          onComplete: internal.pipeline.onTranscribeComplete,
          context: { sessionId },
        },
      )
    }
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
    const project = await ctx.db.get('projects', (
      await ctx.db.get('sessions', segment.sessionId)
    )?.projectId ?? ('' as Id<'projects'>))
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
  },
  handler: async (ctx, { segmentId, text, words, model }) => {
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
        outcome: 'skipped',
      })
      return null
    }

    await ctx.runMutation(internal.pipeline.recordJob, {
      sessionId: context.sessionId,
      step: 'transcribe',
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
      })
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId: context.sessionId,
        step: 'transcribe',
        outcome: 'succeeded',
        durationMs: Date.now() - started,
      })
    } catch (error) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId: context.sessionId,
        step: 'transcribe',
        outcome: 'failed',
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      // Rethrow so the pool retries with backoff. Swallowing here is exactly
      // how the previous build lost sessions quietly.
      throw error
    }
    return null
  },
})

/**
 * Fires after each transcription, success or failure. When every answer has a
 * transcript, the report job goes on the queue — once.
 */
export const onTranscribeComplete = internalMutation({
  args: {
    workId: v.string(),
    context: v.object({ sessionId: v.id('sessions') }),
    result: v.any(),
  },
  handler: async (ctx, { context }): Promise<null> => {
    const { sessionId } = context
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const uploaded = segments.filter((s) => s.uploadState === 'uploaded')
    if (uploaded.length === 0) return null

    const transcripts = await ctx.db
      .query('transcripts')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const transcribed = new Set(transcripts.map((t) => t.segmentId))
    if (!uploaded.every((segment) => transcribed.has(segment._id))) return null

    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (report) return null

    await reportPool.enqueueAction(
      ctx,
      internal.pipeline.generateReport,
      { sessionId },
      {
        onComplete: internal.pipeline.onReportComplete,
        context: { sessionId },
      },
    )
    return null
  },
})

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

    const answers = segments
      .filter((segment) => segment.uploadState === 'uploaded')
      .sort((a, b) => a.questionIndex - b.questionIndex)
      .map((segment) => {
        const transcript = bySegment.get(segment._id)
        const question = questions.find(
          (q) => q.orderIndex === segment.questionIndex,
        )
        return {
          segmentId: segment._id,
          questionId: segment.questionId,
          questionIndex: segment.questionIndex,
          durationSeconds: segment.durationSeconds ?? null,
          maxResponseSeconds: question?.maxResponseSeconds ?? 120,
          question: question?.content ?? '',
          text: transcript?.text ?? '',
          chunks: transcript?.words ?? [],
        }
      })

    return {
      alreadyGenerated: false as const,
      orgId: session.orgId,
      language: project.language,
      jobTitle: project.jobTitle ?? project.title,
      candidateName: session.candidateName,
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
    report: v.any(),
    paraverbal: v.any(),
    model: v.string(),
  },
  handler: async (ctx, { sessionId, report, paraverbal, model }) => {
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
      paraverbal: paraverbal ?? undefined,
      model,
      generatedAt: Date.now(),
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
    if (inputs.criteria.length === 0 || inputs.answers.length === 0) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'skipped',
        error:
          inputs.criteria.length === 0 ? 'no_criteria' : 'no_transcribed_answers',
      })
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
        candidateName: inputs.candidateName,
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

      const { value, model } = await complete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        schema: reportOutputSchema,
        schemaName: 'interview_report',
        tier: 'deep',
        temperature: 0.2,
      })

      const built = buildReport({
        output: value,
        criteria: inputs.criteria,
        answers: inputs.answers,
      })
      const paraverbal = computeParaverbal(
        inputs.answers.map((answer) => ({
          chunks: answer.chunks,
          durationSeconds: answer.durationSeconds ?? 0,
          maxResponseSeconds: answer.maxResponseSeconds,
        })),
      )

      await ctx.runMutation(internal.pipeline.saveReport, {
        sessionId,
        report: built,
        paraverbal,
        model,
      })
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'succeeded',
        durationMs: Date.now() - started,
      })
    } catch (error) {
      await ctx.runMutation(internal.pipeline.recordJob, {
        sessionId,
        step: 'report',
        outcome: 'failed',
        durationMs: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    return null
  },
})

export const onReportComplete = internalMutation({
  args: {
    workId: v.string(),
    context: v.object({ sessionId: v.id('sessions') }),
    result: v.any(),
  },
  handler: async (ctx, { context }): Promise<null> => {
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', context.sessionId))
      .unique()
    if (!report) return null
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
      throw error
    }
    return null
  },
})
