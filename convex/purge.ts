/**
 * Erasure — the candidate's right, the recruiter's action, and the retention
 * clock, all through the same two steps so they cannot drift apart.
 *
 * Deleting objects and deleting rows are separate on purpose: object storage
 * is not transactional, so the order matters. Objects go first. If the row
 * deletion then fails, a retry finds the objects already gone (a 404 counts as
 * success) and finishes the job. The reverse order would leave orphaned video
 * in a bucket with nothing left in the database pointing at it — unfindable,
 * undeletable, and still personal data.
 */

import { ConvexError, v } from 'convex/values'

import { internalMutation, internalQuery } from './_generated/server'
import type { Id } from './_generated/dataModel'

/**
 * A stable, non-reversible identifier for the deletion register. Hashing the
 * address lets the register answer "did you erase this person's data?" without
 * keeping the address it exists to record the destruction of.
 */
export async function hashEmail(email: string): Promise<string> {
  const data = new TextEncoder().encode(email.trim().toLowerCase())
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
}

/** Every object this session ever caused to be written. */
export const collectSessionObjects = internalQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return null
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()

    // Segment rows are written BEFORE the upload, so even an answer whose
    // upload failed has its keys here. That is what makes erasure exact
    // rather than a scan-and-hope.
    const keys = [
      ...segments.flatMap((segment) =>
        [segment.videoKey, segment.audioKey, segment.thumbnailKey].filter(
          (key): key is string => key !== undefined,
        ),
      ),
      session.cvKey,
      session.coverLetterKey,
    ].filter((key): key is string => key !== undefined)

    return {
      orgId: session.orgId,
      candidateEmail: session.candidateEmail,
      keys,
    }
  },
})

/**
 * Remove every row belonging to a session, and record that it happened.
 *
 * Idempotent: a session already gone is a success, because the caller may be
 * a retry of a job whose object deletion succeeded and whose row deletion did
 * not.
 */
export const deleteSessionRecords = internalMutation({
  args: {
    sessionId: v.id('sessions'),
    reason: v.union(
      v.literal('retention'),
      v.literal('candidate_request'),
      v.literal('recruiter_delete'),
    ),
    candidateEmailHash: v.string(),
    objectsDeleted: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId)
    if (!session) return null

    const reports = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect()
    for (const report of reports) {
      const shares = await ctx.db
        .query('reportShares')
        .withIndex('by_report', (q) => q.eq('reportId', report._id))
        .collect()
      for (const share of shares) await ctx.db.delete('reportShares', share._id)
      await ctx.db.delete('reports', report._id)
    }

    for (const table of ['transcripts', 'segments', 'sessionEvents'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
        .collect()
      for (const row of rows) await ctx.db.delete(table, row._id)
    }
    const jobs = await ctx.db
      .query('jobLog')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect()
    for (const job of jobs) await ctx.db.delete('jobLog', job._id)

    const project = await ctx.db.get('projects', session.projectId)
    if (project) {
      await ctx.db.patch('projects', project._id, {
        sessionCount: Math.max(0, project.sessionCount - 1),
        completedSessionCount:
          session.status === 'completed'
            ? Math.max(0, project.completedSessionCount - 1)
            : project.completedSessionCount,
      })
    }

    await ctx.db.delete('sessions', args.sessionId)
    await ctx.db.insert('purgeLog', {
      orgId: session.orgId,
      sessionId: args.sessionId,
      candidateEmailHash: args.candidateEmailHash,
      reason: args.reason,
      objectsDeleted: args.objectsDeleted,
      purgedAt: Date.now(),
    })
    return null
  },
})

/**
 * Retention purge: the media goes, the assessment stays.
 *
 * Keeping the report and transcript past the recordings is deliberate — a
 * hiring decision has to remain justifiable after the video is gone, and the
 * recordings are the part that is disproportionate to keep for years.
 */
export const clearSessionMedia = internalMutation({
  args: {
    sessionId: v.id('sessions'),
    candidateEmailHash: v.string(),
    objectsDeleted: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId)
    if (!session) return null

    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', args.sessionId))
      .collect()
    for (const segment of segments) {
      await ctx.db.patch('segments', segment._id, {
        videoKey: undefined,
        audioKey: undefined,
        thumbnailKey: undefined,
      })
    }
    // `purgeAfter` stays. It is the record of which clock ran out, and
    // clearing it would make a purged session indistinguishable from one that
    // never had a clock. `mediaPurgedAt` is what takes the session out of
    // `sessionsDueForPurge`.
    await ctx.db.patch('sessions', args.sessionId, {
      cvKey: undefined,
      coverLetterKey: undefined,
      mediaPurgedAt: Date.now(),
    })
    await ctx.db.insert('purgeLog', {
      orgId: session.orgId,
      sessionId: args.sessionId,
      candidateEmailHash: args.candidateEmailHash,
      reason: 'retention',
      objectsDeleted: args.objectsDeleted,
      purgedAt: Date.now(),
    })
    return null
  },
})

/**
 * Sessions whose retention clock has run out and whose media is still there.
 *
 * Both bounds matter. `purgeAfter` is optional, and an absent field sorts
 * before every number in a Convex index, so a range bounded only from above
 * starts at the head of the index and is filled by every session that has no
 * clock at all — the batch is spent before it reaches a single due one.
 * `gt(0)` excludes them. The leading `eq('mediaPurgedAt', undefined)` excludes
 * sessions already purged, which would otherwise stay in range for good and
 * re-purge on every pass.
 */
export const sessionsDueForPurge = internalQuery({
  args: { before: v.number(), limit: v.number() },
  handler: async (ctx, { before, limit }) => {
    const due = await ctx.db
      .query('sessions')
      .withIndex('by_media_purged_and_purge_after', (q) =>
        q
          .eq('mediaPurgedAt', undefined)
          .gt('purgeAfter', 0)
          .lt('purgeAfter', before),
      )
      .take(limit)
    return due.map((session) => session._id)
  },
})

export function assertSessionId(value: string): Id<'sessions'> {
  if (!value) throw new ConvexError('not_found')
  return value as Id<'sessions'>
}
