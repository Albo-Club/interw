import { cronJobs } from 'convex/server'

import { internal } from './_generated/api'

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

export default crons
