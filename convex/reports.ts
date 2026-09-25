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

import enReport from '../src/locales/en/report.json'
import frReport from '../src/locales/fr/report.json'
import { action, internalQuery, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { languageValidator, recruiterDecisionValidator } from './schema'
import { requireOrgMember } from './lib/auth'
import {
  canSeeProject,
  requireProjectAccess,
  requireProjectOwnerOrAdmin,
} from './lib/projectAccess'
import { relaunchPipeline } from './admin'
import { consumeLimit } from './rateLimiters'
import { normalizeWeights } from './lib/weights'
import { presignGet } from './lib/objectStore'
import type { Doc, Id } from './_generated/dataModel'

const NOTE_MAX = 4_000
/** How much decision history the candidate page shows. */
const DECISION_HISTORY_MAX = 20

export const forSession = query({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { project, user, member } = await requireProjectAccess(
      ctx,
      session.projectId,
    )

    const [
      criteria,
      questions,
      segments,
      transcripts,
      report,
      events,
      decisions,
    ] = await Promise.all([
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
      ctx.db
        .query('decisionEvents')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .order('desc')
        .take(DECISION_HISTORY_MAX),
    ])

    const transcriptBySegment = new Map(
      transcripts.map((transcript) => [transcript.segmentId, transcript]),
    )
    const questionById = new Map(questions.map((q) => [q._id, q]))
    const decidedBy = session.recruiterDecisionBy
      ? await ctx.db.get('users', session.recruiterDecisionBy)
      : null
    const actors = new Map(
      await Promise.all(
        [...new Set(decisions.map((event) => event.actorId))].map(
          async (id) => [id, await ctx.db.get('users', id)] as const,
        ),
      ),
    )

    return {
      // Mirrors `requireProjectOwnerOrAdmin`, which is what enforces it: this
      // only spares a member a button the server would refuse.
      canManage:
        member.role === 'owner' ||
        member.role === 'admin' ||
        project.createdBy === user._id,
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
            hasVideo: segment.videoKey !== undefined,
            transcript: transcript?.text ?? null,
          }
        }),
      report: report ? serializeReport(report) : null,
      // A departed colleague reads as null, not as an address kept alive.
      decisionHistory: decisions.map((event) => {
        const actor = actors.get(event.actorId)
        return {
          decision: event.decision ?? null,
          at: event.at,
          by: actor ? { name: actor.name ?? null, email: actor.email } : null,
        }
      }),
      // The last few pipeline transitions, so "why is there no report yet?" is
      // answerable on the page instead of in a support thread.
      // No `error`: it holds raw provider output, which is for operators.
      pipeline: events.map((event) => ({
        step: event.step,
        outcome: event.outcome,
        at: event.at,
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
    // Team level on purpose (audit Back F2): whoever can see the role — its
    // team, or an org owner or admin — may decide. The team is the people
    // hiring for it; accountability comes from naming who decided
    // (`recruiterDecisionBy`, `decisionEvents`), not from a rank. See
    // KNOWN_ISSUES.md § "Decisions and report links are team-level".
    const { user } = await requireProjectAccess(ctx, session.projectId)
    // Re-setting the current decision changes nothing, so it records nothing.
    if ((session.recruiterDecision ?? null) === decision) return null
    const now = Date.now()
    await ctx.db.patch('sessions', sessionId, {
      recruiterDecision: decision ?? undefined,
      recruiterDecisionBy: decision ? user._id : undefined,
      recruiterDecisionAt: decision ? now : undefined,
    })
    await ctx.db.insert('decisionEvents', {
      orgId: session.orgId,
      sessionId,
      decision: decision ?? undefined,
      actorId: user._id,
      at: now,
    })
    return null
  },
})

/**
 * Run the analysis again, from the candidate page, when it did not complete.
 *
 * The creator of the role or an org owner/admin — the people accountable for
 * what the role costs — and rate-limited per person, because each relaunch
 * can re-bill transcription and a deep-model completion. Logged in `jobLog`
 * with who asked, like the operator's relaunch it shares its logic with.
 */
export const relaunch = mutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { user } = await requireProjectOwnerOrAdmin(ctx, session.projectId)
    // With a report in hand there is nothing to finish, and re-running the
    // failed transcriptions would be billed for a report nobody regenerates.
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (report) throw new ConvexError('report_exists')
    await consumeLimit(ctx, 'reportRelaunch', user._id)
    await relaunchPipeline(ctx, session, user._id)
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
      segments: segments.map((segment) => ({
        segmentId: segment._id,
        key: segment.videoKey ?? segment.audioKey ?? null,
        kind: segment.videoKey ? ('video' as const) : ('audio' as const),
      })),
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
  args: {
    sessionId: v.id('sessions'),
    /** The recruiter's UI language, which names the downloaded documents. */
    language: v.optional(languageValidator),
  },
  handler: async (
    ctx,
    { sessionId, language },
  ): Promise<{
    segments: Array<{ segmentId: Id<'segments'>; url: string; kind: 'audio' | 'video' }>
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
    // Named in the recruiter's language, from the same copy the page shows
    // for the link, and carrying the stored extension so the file opens.
    const labels = (language === 'fr' ? frReport : enReport).documents
    const download = (key: string, label: string) =>
      presignGet(key, undefined, {
        download: `${label} - ${target.candidateName}.${key.split('.').pop()}`
          // A header value: ASCII only, whatever the name was typed in.
          .replace(/[^\w .-]/g, '_'),
      })
    return {
      segments,
      cv: target.cvKey ? await download(target.cvKey, labels.cv) : null,
      coverLetter: target.coverLetterKey
        ? await download(target.coverLetterKey, labels.coverLetter)
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
      if (!(await canSeeProject(ctx, project, user._id, member.role))) continue
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
