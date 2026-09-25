/**
 * Sharing one report outside the account.
 *
 * A share link is a deliberate, revocable, expiring grant to exactly one
 * report — never to an account, never to a role, never to another candidate.
 *
 * What a share link shows, and what it deliberately does not:
 *   shown    the assessment, its quotes, and the recordings those quotes
 *            point at. Without the recordings a hiring manager cannot check a
 *            claim, and the realistic alternative is the recruiter emailing
 *            the video files around, which is strictly worse.
 *   withheld the recruiter's private note (it is a working note, not an
 *            assessment), the candidate's CV, cover letter, phone and
 *            LinkedIn. Those are the candidate's own documents and contact
 *            details; nothing about reviewing an assessment requires them.
 */

import { ConvexError, v } from 'convex/values'

import { action, internalQuery, mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import {
  criteriaScoresValidator,
  fitMatrixValidator,
  paraverbalValidator,
  recommendationValidator,
} from './schema'
import { effectiveNow } from './lib/clock'
import { requireProjectAccess } from './lib/projectAccess'
import { generateToken, looksLikeToken } from './lib/tokens'
import { normalizeWeights } from './lib/weights'
import { playbackMedia, presignGet } from './lib/objectStore'
import { consumeLimit } from './rateLimiters'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

export type ShareState = 'active' | 'expired' | 'revoked' | 'not_found'

function shareUrl(token: string): string {
  const siteUrl = process.env.SITE_URL
  if (!siteUrl) throw new ConvexError('site_url_not_configured')
  return `${siteUrl.replace(/\/+$/, '')}/r/${token}`
}

async function resolveShare(
  ctx: GenericQueryCtx<DataModel>,
  token: string,
  now: number,
): Promise<
  | { state: Exclude<ShareState, 'active'>; share: null }
  | { state: 'active'; share: Doc<'reportShares'> }
> {
  if (!looksLikeToken(token)) return { state: 'not_found', share: null }
  const share = await ctx.db
    .query('reportShares')
    .withIndex('by_token', (q) => q.eq('token', token))
    .unique()
  if (!share) return { state: 'not_found', share: null }
  // An organisation being deleted takes its share links down with it at once,
  // not when erasure reaches the report — and fails like any unknown link.
  const org = await ctx.db.get('organizations', share.orgId)
  if (!org || org.deletingAt !== undefined) {
    return { state: 'not_found', share: null }
  }
  if (share.revokedAt !== undefined) return { state: 'revoked', share: null }
  if (share.expiresAt !== undefined && share.expiresAt < now) {
    return { state: 'expired', share: null }
  }
  return { state: 'active', share }
}

/* ────────────────────────── Recruiter side ─────────────────────────────── */

export const forReport = query({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    await requireProjectAccess(ctx, session.projectId)
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (!report) return []

    const shares = await ctx.db
      .query('reportShares')
      .withIndex('by_report', (q) => q.eq('reportId', report._id))
      .collect()
    return shares
      .filter((share) => share.revokedAt === undefined)
      .map((share) => ({
        _id: share._id,
        url: shareUrl(share.token),
        expiresAt: share.expiresAt ?? null,
        lastViewedAt: share.lastViewedAt ?? null,
        viewCount: share.viewCount,
        createdAt: share.createdAt,
      }))
  },
})

export const create = mutation({
  args: {
    sessionId: v.id('sessions'),
    /** Days until it stops working, or null for no expiry. */
    expiresInDays: v.union(v.number(), v.null()),
  },
  handler: async (ctx, { sessionId, expiresInDays }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { user } = await requireProjectAccess(ctx, session.projectId)
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (!report) throw new ConvexError('no_report')

    const token = generateToken()
    await ctx.db.insert('reportShares', {
      orgId: session.orgId,
      reportId: report._id,
      token,
      createdBy: user._id,
      expiresAt:
        expiresInDays === null
          ? undefined
          : Date.now() + expiresInDays * 24 * 60 * 60 * 1000,
      viewCount: 0,
      createdAt: Date.now(),
    })
    return { url: shareUrl(token) }
  },
})

/**
 * Revoke rather than delete: the row stays, so "this link was revoked" can be
 * shown to whoever still has it, and the audit trail survives.
 */
export const revoke = mutation({
  args: { shareId: v.id('reportShares') },
  handler: async (ctx, { shareId }) => {
    const share = await ctx.db.get('reportShares', shareId)
    if (!share) throw new ConvexError('not_found')
    const report = await ctx.db.get('reports', share.reportId)
    if (!report) throw new ConvexError('not_found')
    const session = await ctx.db.get('sessions', report.sessionId)
    if (!session) throw new ConvexError('not_found')
    await requireProjectAccess(ctx, session.projectId)
    await ctx.db.patch('reportShares', shareId, { revokedAt: Date.now() })
    return null
  },
})

/* ─────────────────────────── Public side ───────────────────────────────── */

/**
 * What a share link is allowed to show.
 *
 * Enforced by Convex on the way out, not only by the code above. The list of
 * what is withheld — the recruiter's private note, the CV, the cover letter,
 * the phone number, the LinkedIn, the access token — is a decision, and a
 * decision that only lives in a `.map()` is one field away from being undone
 * by someone adding "just the email so we can reply".
 */
const shareViewReturns = v.object({
  state: v.union(
    v.literal('active'),
    v.literal('expired'),
    v.literal('revoked'),
    v.literal('not_found'),
  ),
  report: v.union(
    v.null(),
    v.object({
      organisationName: v.string(),
      jobTitle: v.string(),
      candidateName: v.string(),
      completedAt: v.union(v.number(), v.null()),
      overallScore: v.number(),
      recommendation: recommendationValidator,
      executiveSummary: v.string(),
      strengths: v.array(v.string()),
      concerns: v.array(v.string()),
      criteria: v.array(
        v.object({
          _id: v.id('criteria'),
          label: v.string(),
          weight: v.number(),
          normalizedWeight: v.number(),
        }),
      ),
      // The same validators the table is defined with: what a share shows of
      // the report IS what the report holds, and a second copy would drift.
      criteriaScores: criteriaScoresValidator,
      fitMatrix: v.union(fitMatrixValidator, v.null()),
      paraverbal: v.union(paraverbalValidator, v.null()),
      answers: v.array(
        v.object({
          segmentId: v.id('segments'),
          questionIndex: v.number(),
          question: v.string(),
        }),
      ),
    }),
  ),
})

export const view = query({
  args: { token: v.string(), now: v.number() },
  returns: shareViewReturns,
  handler: async (ctx, { token, now }) => {
    // `now` is the viewer's clock, and the viewer is whoever holds the link.
    // It stays, because it is what makes an expiry visible without polling —
    // but it cannot decide the expiry. See convex/lib/clock.ts.
    const resolved = await resolveShare(ctx, token, effectiveNow(now))
    if (resolved.state !== 'active') {
      return { state: resolved.state, report: null }
    }

    const report = await ctx.db.get('reports', resolved.share.reportId)
    if (!report) return { state: 'not_found' as const, report: null }
    const session = await ctx.db.get('sessions', report.sessionId)
    if (!session) return { state: 'not_found' as const, report: null }
    const project = await ctx.db.get('projects', session.projectId)
    const org = await ctx.db.get('organizations', session.orgId)

    const [criteria, questions, segments] = await Promise.all([
      project
        ? ctx.db
            .query('criteria')
            .withIndex('by_project', (q) => q.eq('projectId', project._id))
            .collect()
        : Promise.resolve([]),
      project
        ? ctx.db
            .query('questions')
            .withIndex('by_project', (q) => q.eq('projectId', project._id))
            .collect()
        : Promise.resolve([]),
      ctx.db
        .query('segments')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .collect(),
    ])

    const questionById = new Map(questions.map((q) => [q._id, q]))

    return {
      state: 'active' as const,
      report: {
        organisationName: org?.name ?? '',
        jobTitle: project?.jobTitle ?? project?.title ?? '',
        // Name only. No email, phone, LinkedIn, CV or recruiter note: nothing
        // about reviewing an assessment requires them.
        candidateName: session.candidateName,
        completedAt: session.completedAt ?? null,
        overallScore: report.overallScore,
        recommendation: report.recommendation,
        executiveSummary: report.executiveSummary,
        strengths: report.strengths,
        concerns: report.concerns,
        criteria: normalizeWeights(
          criteria.map((criterion) => ({
            _id: criterion._id,
            label: criterion.label,
            weight: criterion.weight,
          })),
        ),
        criteriaScores: report.criteriaScores,
        fitMatrix: report.fitMatrix ?? null,
        paraverbal: report.paraverbal ?? null,
        answers: segments
          .sort((a, b) => a.questionIndex - b.questionIndex)
          .map((segment) => ({
            segmentId: segment._id,
            questionIndex: segment.questionIndex,
            // By id, not by index: see convex/pipeline.ts.
            question: questionById.get(segment.questionId)?.content ?? '',
          })),
      },
    }
  },
})

/** Records the view. A mutation so it can be rate limited and counted. */
export const recordView = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    // Resolve first: keyed on the raw argument, the limiter would let an
    // anonymous caller choose the keys written to its store.
    const resolved = await resolveShare(ctx, token, Date.now())
    if (resolved.state !== 'active') return null
    await consumeLimit(ctx, 'shareView', resolved.share._id)
    await ctx.db.patch('reportShares', resolved.share._id, {
      lastViewedAt: Date.now(),
      viewCount: resolved.share.viewCount + 1,
    })
    return null
  },
})

export const resolveSharedMedia = internalQuery({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    // Its only caller is the action below, which passes the server's clock.
    // Bounded anyway: the guarantee should not rest on every future caller
    // remembering.
    const resolved = await resolveShare(ctx, token, effectiveNow(now))
    if (resolved.state !== 'active') return null
    const report = await ctx.db.get('reports', resolved.share.reportId)
    if (!report) return null
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', report.sessionId))
      .collect()
    return segments.flatMap((segment) => {
      const media = playbackMedia(segment)
      return media ? [{ segmentId: segment._id, key: media.key }] : []
    })
  },
})

/**
 * Playback for a shared report.
 *
 * The share token is re-checked here, server-side, before a single URL is
 * signed — a revoked or expired link mints nothing, and the URLs it did mint
 * die within the hour.
 *
 * An action has the server's clock and nothing reactive to preserve, so it
 * uses it. `now` is still accepted, and still ignored: the client that sends
 * it has no say in whether the link it holds has expired.
 */
export const sharedMediaUrls = action({
  args: { token: v.string(), now: v.optional(v.number()) },
  handler: async (
    ctx,
    { token },
  ): Promise<Array<{ segmentId: Id<'segments'>; url: string }>> => {
    const segments = await ctx.runQuery(internal.shares.resolveSharedMedia, {
      token,
      now: Date.now(),
    })
    if (!segments) return []
    return await Promise.all(
      segments.map(async (segment) => ({
        segmentId: segment.segmentId,
        url: await presignGet(segment.key),
      })),
    )
  },
})
