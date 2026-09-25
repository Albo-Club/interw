/**
 * Retention: recordings do not live forever.
 *
 * Twelve months after an interview completes, the video and audio go and the
 * assessment stays. That split is the point — a hiring decision has to remain
 * justifiable after the fact, and the recordings are the part that is
 * disproportionate to keep for years.
 *
 * The purge runs as a scheduled job, in bounded batches, and records every
 * pass. A retention policy nobody can prove ran is not a retention policy.
 */

import { v } from 'convex/values'

import { internalAction, internalMutation } from './_generated/server'
import { internal } from './_generated/api'
import { deleteObjects } from './lib/objectStore'
import { hashEmail } from './purge'

/** Bounded so one pass cannot outrun an action's time or memory budget. */
const BATCH_SIZE = 25

/** How far a session that failed to purge is moved back in the queue. The
 *  due range is read in `purgeAfter` order, so without this the same failing
 *  session heads every batch and nothing behind it is ever purged. */
const RETRY_DELAY_MS = 24 * 60 * 60 * 1000

export const recordPurgeFailure = internalMutation({
  args: { sessionId: v.id('sessions'), error: v.string() },
  handler: async (ctx, { sessionId, error }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return null
    const now = Date.now()
    await ctx.db.patch('sessions', sessionId, {
      purgeAfter: now + RETRY_DELAY_MS,
    })
    await ctx.db.insert('jobLog', {
      orgId: session.orgId,
      sessionId,
      step: 'purge',
      outcome: 'failed',
      attempt: 1,
      error: error.slice(0, 1_000),
      at: now,
    })
    return null
  },
})

export const purgeDueSessions = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (
    ctx,
    { limit },
  ): Promise<{ purged: number; failed: number }> => {
    const due = await ctx.runQuery(internal.purge.sessionsDueForPurge, {
      before: Date.now(),
      limit: limit ?? BATCH_SIZE,
    })

    let purged = 0
    let failed = 0
    for (const sessionId of due) {
      // One session at a time, each on its own: an object the store will not
      // delete must cost that session a retry, not the whole deployment its
      // retention.
      try {
        const objects = await ctx.runQuery(
          internal.purge.collectSessionObjects,
          { sessionId },
        )
        if (!objects) continue
        // Objects first. A failure here leaves the row intact and a later
        // pass retries; the reverse order would orphan video nothing points at.
        await deleteObjects(objects.keys)
        await ctx.runMutation(internal.purge.clearSessionMedia, {
          sessionId,
          candidateEmailHash: await hashEmail(objects.candidateEmail),
          objectsDeleted: objects.keys.length,
        })
        purged += 1
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        console.error(
          'retention_purge_failed ' + JSON.stringify({ sessionId, message }),
        )
        await ctx.runMutation(internal.retention.recordPurgeFailure, {
          sessionId,
          error: message,
        })
        failed += 1
      }
    }
    return { purged, failed }
  },
})
