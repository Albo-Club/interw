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

import { internalAction } from './_generated/server'
import { internal } from './_generated/api'
import { deleteObjects } from './lib/objectStore'
import { hashEmail } from './purge'

/** Bounded so one pass cannot outrun an action's time or memory budget. */
const BATCH_SIZE = 25

export const purgeDueSessions = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ purged: number }> => {
    const due = await ctx.runQuery(internal.purge.sessionsDueForPurge, {
      before: Date.now(),
      limit: limit ?? BATCH_SIZE,
    })

    let purged = 0
    for (const sessionId of due) {
      const objects = await ctx.runQuery(
        internal.purge.collectSessionObjects,
        { sessionId },
      )
      if (!objects) continue
      // Objects first. A failure here leaves the row intact and the next pass
      // retries; the reverse order would orphan video nothing points at.
      await deleteObjects(objects.keys)
      await ctx.runMutation(internal.purge.clearSessionMedia, {
        sessionId,
        candidateEmailHash: await hashEmail(objects.candidateEmail),
        objectsDeleted: objects.keys.length,
      })
      purged += 1
    }
    return { purged }
  },
})
