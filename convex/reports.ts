/**
 * Reading an interview, recruiter side.
 *
 * The shape of `forSession` is set by what the candidate page has to do: open
 * on the verdict, then the criteria, then the proof — and let any claim jump
 * to the second of video behind it. So the query returns the report already
 * joined to its criteria labels, its questions, and the segment each quote
 * belongs to. Playback URLs are minted separately, by an action, because they
 * expire and a reactive query would cache a dead one.
 */

import { ConvexError, v } from 'convex/values'

import { action, internalQuery, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { recruiterDecisionValidator } from './schema'
import { requireOrgMember } from './lib/auth'
import { requireProjectAccess } from './lib/projectAccess'
import { normalizeWeights } from './lib/weights'
import { playbackMedia, presignGet } from './lib/objectStore'
import type { Doc, Id } from './_generated/dataModel'

const NOTE_MAX = 4_000

export const forSession = query({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { project } = await requireProjectAccess(ctx, session.projectId)

    const [criteria, questions, segments, transcripts, report, events] =
      await Promise.all([
        ctx.db
          .query('criteria')
          .withIndex('by_project', (q) => q.eq('projectId', project._id))
          .collect(),
        ctx.db
          .query('questions')
          .withIndex('by_project', (q) => q.eq('projectId', project._id))
          .collect(),
        ctx.db
          .query('segments')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .collect(),
        ctx.db
          .query('transcripts')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .collect(),
        ctx.db
          .query('reports')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .unique(),
        ctx.db
          .query('jobLog')
          .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
          .order('desc')
          .take(20),
      ])

    const transcriptBySegment = new Map(
      transcripts.map((transcript) => [transcript.segmentId, transcript]),
    )
    const questionById = new Map(questions.map((q) => [q._id, q]))
    const decidedBy = session.recruiterDecisionBy
      ? await ctx.db.get('users', session.recruiterDecisionBy)
      : null

    return {
      session: {
        _id: session._id,
        candidateName: session.candidateName,
        candidateEmail: session.candidateEmail,
        candidatePhone: session.candidatePhone ?? null,
        candidateLinkedin: session.candidateLinkedin ?? null,
        hasCv: session.cvKey !== undefined,
        hasCoverLetter: session.coverLetterKey !== undefined,
        status: session.status,
        invitedAt: session.invitedAt,
        startedAt: session.startedAt ?? null,
        completedAt: session.completedAt ?? null,
        durationSeconds: session.durationSeconds ?? null,
        recruiterDecision: session.recruiterDecision ?? null,
        recruiterDecisionAt: session.recruiterDecisionAt ?? null,
        recruiterDecisionBy: decidedBy
          ? { name: decidedBy.name ?? null, email: decidedBy.email }
          : null,
        recruiterNote: session.recruiterNote ?? null,
        mediaPurgedAt: session.mediaPurgedAt ?? null,
      },
      project: {
        _id: project._id,
        slug: project.slug,
        title: project.title,
        jobTitle: project.jobTitle ?? null,
        language: project.language,
      },
      criteria: normalizeWeights(
        criteria.map((criterion) => ({
          _id: criterion._id,
          label: criterion.label,
          description: criterion.description ?? null,
          weight: criterion.weight,
        })),
      ),
      answers: segments
        .sort((a, b) => a.questionIndex - b.questionIndex)
        .map((segment) => {
          // By id, not by index: see convex/pipeline.ts.
          const question = questionById.get(segment.questionId)
          const transcript = transcriptBySegment.get(segment._id)
          return {
            segmentId: segment._id,
            questionIndex: segment.questionIndex,
            question: question?.content ?? '',
            // What the server measured first. The browser's own figure only
            // for answers transcribed before `measuredSeconds` existed.
            durationSeconds:
              segment.measuredSeconds ?? segment.durationSeconds ?? null,
            uploadState: segment.uploadState,
            hasVideo: playbackMedia(segment)?.kind === 'video',
            transcript: transcript?.text ?? null,
          }
        }),
      report: report ? serializeReport(report) : null,
      // The last few pipeline transitions, so "why is there no report yet?" is
      // answerable on the page instead of in a support thread.
      pipeline: events.map((event) => ({
        step: event.step,
        outcome: event.outcome,
        at: event.at,
        error: event.error ?? null,
      })),
    }
  },
})

function serializeReport(report: Doc<'reports'>) {
  return {
    overallScore: report.overallScore,
    recommendation: report.recommendation,
    executiveSummary: report.executiveSummary,
    criteriaScores: report.criteriaScores,
    strengths: report.strengths,
    concerns: report.concerns,
    fitMatrix: report.fitMatrix ?? null,
    paraverbal: report.paraverbal ?? null,
    highlights: report.highlights ?? null,
    model: report.model,
    generatedAt: report.generatedAt,
  }
}

export const setDecision = mutation({
  args: {
    sessionId: v.id('sessions'),
    decision: v.union(recruiterDecisionValidator, v.null()),
  },
  handler: async (ctx, { sessionId, decision }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { user } = await requireProjectAccess(ctx, session.projectId)
    await ctx.db.patch('sessions', sessionId, {
      recruiterDecision: decision ?? undefined,
      recruiterDecisionBy: decision ? user._id : undefined,
      recruiterDecisionAt: decision ? Date.now() : undefined,
    })
    return null
  },
})

export const setNote = mutation({
  args: { sessionId: v.id('sessions'), note: v.string() },
  handler: async (ctx, { sessionId, note }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    await requireProjectAccess(ctx, session.projectId)
    const trimmed = note.trim()
    if (trimmed.length > NOTE_MAX) throw new ConvexError('note_too_long')
    await ctx.db.patch('sessions', sessionId, {
      recruiterNote: trimmed || undefined,
    })
    return null
  },
})

/* ─────────────────────────── Playback ──────────────────────────────────── */

export const resolveSessionMedia = internalQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    await requireProjectAccess(ctx, session.projectId)
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    return {
      candidateName: session.candidateName,
      segments: segments.map((segment) => {
        const media = playbackMedia(segment)
        return {
          segmentId: segment._id,
          key: media?.key ?? null,
          kind: media?.kind ?? ('audio' as const),
        }
      }),
      cvKey: session.cvKey ?? null,
      coverLetterKey: session.coverLetterKey ?? null,
    }
  },
})

/**
 * Signed playback URLs for one candidate's interview, in a single call.
 *
 * An action rather than a query on purpose: these URLs expire in an hour, and
 * a reactive query would happily serve a cached one long after it died.
 */
export const sessionMediaUrls = action({
  args: { sessionId: v.id('sessions') },
  handler: async (
    ctx,
    { sessionId },
  ): Promise<{
    segments: Array<{ segmentId: Id<'segments'>; url: string; kind: string }>
    cv: string | null
    coverLetter: string | null
  }> => {
    const target = await ctx.runQuery(internal.reports.resolveSessionMedia, {
      sessionId,
    })
    const segments = await Promise.all(
      target.segments
        .filter((segment) => segment.key !== null)
        .map(async (segment) => ({
          segmentId: segment.segmentId,
          kind: segment.kind,
          url: await presignGet(segment.key!),
        })),
    )
    const safeName = target.candidateName.replace(/[^\w .-]/g, '_')
    return {
      segments,
      cv: target.cvKey
        ? await presignGet(target.cvKey, undefined, {
            download: `CV - ${safeName}`,
          })
        : null,
      coverLetter: target.coverLetterKey
        ? await presignGet(target.coverLetterKey, undefined, {
            download: `Lettre - ${safeName}`,
          })
        : null,
    }
  },
})

/* ──────────────────────────── Global search ────────────────────────────── */

/**
 * Find a candidate by name across the organisation.
 *
 * `orgId` is a filter field on the search index, not a post-filter: the query
 * cannot reach past the caller's organisation even by accident.
 */
export const searchCandidates = query({
  args: { orgId: v.id('organizations'), text: v.string() },
  handler: async (ctx, { orgId, text }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    const trimmed = text.trim()
    if (trimmed.length < 2) return []

    const matches = await ctx.db
      .query('sessions')
      .withSearchIndex('search_candidate', (q) =>
        q.search('candidateName', trimmed).eq('orgId', orgId),
      )
      .take(25)

    const visible: Array<{
      sessionId: Id<'sessions'>
      candidateName: string
      candidateEmail: string
      status: Doc<'sessions'>['status']
      projectTitle: string
      projectSlug: string
      completedAt: number | null
    }> = []
    for (const session of matches) {
      const project = await ctx.db.get('projects', session.projectId)
      if (!project) continue
      // Project-level visibility applies to search too, otherwise a
      // confidential role leaks through the search box.
      if (
        project.restricted &&
        member.role === 'member' &&
        project.createdBy !== user._id
      ) {
        const share = await ctx.db
          .query('projectShares')
          .withIndex('by_project_and_user', (q) =>
            q.eq('projectId', project._id).eq('userId', user._id),
          )
          .unique()
        if (!share) continue
      }
      visible.push({
        sessionId: session._id,
        candidateName: session.candidateName,
        candidateEmail: session.candidateEmail,
        status: session.status,
        projectTitle: project.title,
        projectSlug: project.slug,
        completedAt: session.completedAt ?? null,
      })
    }
    return visible
  },
})
