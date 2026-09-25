import { cronJobs } from 'convex/server'

import { components, internal } from './_generated/api'
import { internalMutation } from './_generated/server'

const crons = cronJobs()

/**
 * Retention purge. Every six hours rather than daily so a backlog drains
 * within a day instead of taking a week of 25-session batches, and so a
 * deployment that was down for a day catches up on its own.
 */
crons.interval(
  'purge recordings past their retention date',
  { hours: 6 },
  internal.retention.purgeDueSessions,
  {},
)

crons.interval(
  'expire the open sessions of roles past their deadline',
  { hours: 1 },
  internal.sessions.expireOverdueSessions,
  { cursor: null },
)

crons.interval(
  'remove old emails from the resend component',
  { hours: 1 },
  internal.crons.cleanupResend,
  {},
)

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * The Resend component keeps its own copy of every email it sent — recipient,
 * subject and the full body, which for an invitation is the candidate's name,
 * the role, the organisation and their interview link. Candidate erasure
 * cannot reach it: the component exposes no per-email delete. It only
 * forgets on this schedule, and only if the app runs it.
 *
 * `emailLog` is the app's record of a send; nothing reads the component's rows
 * once a delivery outcome has reached it. Seven days after that outcome is room
 * for a late spam complaint to still land on `emailLog`. An email that never
 * reached an outcome goes after thirty days regardless, so thirty days after
 * sending is the longest any copy survives. Both are the component's defaults,
 * named here so an upgrade cannot move them silently.
 */
export const cleanupResend = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.scheduler.runAfter(0, components.resend.lib.cleanupOldEmails, {
      olderThan: 7 * DAY_MS,
    })
    await ctx.scheduler.runAfter(
      0,
      components.resend.lib.cleanupAbandonedEmails,
      { olderThan: 30 * DAY_MS },
    )
    return null
  },
})

export default crons
