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
import { components, internal } from './_generated/api'
import { deleteObjects } from './lib/objectStore'
import { canSeeProject } from './lib/projectAccess'
import type { ActionCtx } from './_generated/server'
import type { GenericMutationCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

/**
 * A stable, non-reversible identifier for the deletion register. Hashing the
 * address lets the register answer "did you erase this person's data?" without
 * keeping the address it exists to record the destruction of.
 *
 * Salted, and the salt is a deployment secret. A bare SHA-256 of an email
 * address is not one-way in any useful sense: the input space is a list of
 * addresses somebody already has, and checking them is one pass of a
 * dictionary. Without the salt the register stores the addresses it exists to
 * prove it destroyed.
 *
 * Rotating `PURGE_HASH_SALT` makes older entries unanswerable — they stay
 * valid proof that *a* session was purged, but you can no longer ask whose.
 * That is the cost of the property, and it is worth it.
 */
export async function hashEmail(email: string): Promise<string> {
  const salt = process.env.PURGE_HASH_SALT
  if (!salt) {
    // Deliberately fatal. Erasure must not quietly fall back to writing the
    // unsalted digest: the register would look exactly as it does now and
    // carry none of the property it claims.
    throw new ConvexError('purge_hash_salt_not_configured')
  }
  const data = new TextEncoder().encode(`${salt}:${email.trim().toLowerCase()}`)
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
    // upload failed has its keys here — and so are document slots, through
    // `pendingDocumentKeys`. That is what makes erasure exact rather than a
    // scan-and-hope.
    const keys = [
      ...new Set(
        [
          ...segments.flatMap((segment) => [
            segment.videoKey,
            segment.audioKey,
            ...(segment.supersededKeys ?? []),
          ]),
          session.cvKey,
          session.coverLetterKey,
          ...(session.pendingDocumentKeys ?? []),
        ].filter((key): key is string => key !== undefined),
      ),
    ]

    return {
      orgId: session.orgId,
      candidateEmail: session.candidateEmail,
      keys,
    }
  },
})

/**
 * How many rows one pass of `deleteSessionRecords` will delete before handing
 * the rest to another pass.
 *
 * A session's row count is not bounded by anything the product controls:
 * `sessionEvents` is written by the candidate's own browser and `jobLog` grows
 * with every retry. Deleting them in one transaction meant erasure could
 * exceed Convex's limits and fail — *after* the objects were already gone, so
 * the candidate saw an error, their recordings were deleted, their rows
 * stayed, and the button would never work again.
 */
const DELETE_BATCH = 100

/**
 * Erase the whole thread a read landed in, with the row that named it. The
 * component deletes the thread page by page on its own schedule, committed in
 * this transaction with the row, so neither can outlive the other.
 */
async function eraseThread(
  ctx: GenericMutationCtx<DataModel>,
  read: Doc<'chatThreadSessions'>,
): Promise<void> {
  await ctx.scheduler.runAfter(
    0,
    components.agent.threads.deleteAllForThreadIdAsync,
    { threadId: read.threadId },
  )
  await ctx.db.delete('chatThreadSessions', read._id)
}

/**
 * Delete up to `budget` child rows of a session. Returns how many it spent.
 *
 * Order matters only for `reports` → `reportShares`: a share must not outlive
 * the report it points at, even for the moment between two passes.
 */
async function deleteChildRows(
  ctx: GenericMutationCtx<DataModel>,
  sessionId: Id<'sessions'>,
  budget: number,
): Promise<number> {
  let spent = 0

  const reports = await ctx.db
    .query('reports')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .take(budget)
  for (const report of reports) {
    const shares = await ctx.db
      .query('reportShares')
      .withIndex('by_report', (q) => q.eq('reportId', report._id))
      .take(budget)
    for (const share of shares) {
      await ctx.db.delete('reportShares', share._id)
      spent += 1
    }
    await ctx.db.delete('reports', report._id)
    spent += 1
  }

  // An assistant thread that read this candidate holds a copy of them — the
  // tool result, and the answer written from it. The whole thread goes: the
  // answer cannot be told apart from the rest of the conversation.
  if (spent >= budget) return spent
  const reads = await ctx.db
    .query('chatThreadSessions')
    .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
    .take(budget - spent)
  for (const read of reads) {
    await eraseThread(ctx, read)
    spent += 1
  }

  // `emailLog` last used to be missing here entirely: the candidate's address
  // survived their own erasure in clear text, indexed by recipient and
  // readable by every member of the organisation through the deliverability
  // screen — while `purgeLog`, three tables away, took care to store only a
  // hash. The rows go rather than being anonymised: a deliverability trail
  // for a candidate who no longer exists is of no use to anyone.
  for (const table of [
    'transcripts',
    'segments',
    'sessionEvents',
    'decisionEvents',
    'jobLog',
    'emailLog',
  ] as const) {
    if (spent >= budget) return spent
    const rows = await ctx.db
      .query(table)
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .take(budget - spent)
    for (const row of rows) {
      await ctx.db.delete(table, row._id)
      spent += 1
    }
  }
  return spent
}

/**
 * Remove every row belonging to a session, and record that it happened.
 *
 * Idempotent, and re-entrant: a session already gone is a success, because the
 * caller may be a retry of a job whose object deletion succeeded and whose row
 * deletion did not — and a session with more rows than one transaction can
 * carry reschedules itself until there are none left. The register is written
 * once, by the pass that removes the session row.
 */
export const deleteSessionRecords = internalMutation({
  args: {
    sessionId: v.id('sessions'),
    reason: v.union(
      v.literal('retention'),
      v.literal('candidate_request'),
      v.literal('recruiter_delete'),
      v.literal('org_delete'),
    ),
    candidateEmailHash: v.string(),
    objectsDeleted: v.number(),
  },
  handler: async (ctx, args) => {
    const session = await ctx.db.get('sessions', args.sessionId)
    if (!session) return null

    const spent = await deleteChildRows(ctx, args.sessionId, DELETE_BATCH)
    if (spent >= DELETE_BATCH) {
      // More to go. The session row stays until the end, so a pass that never
      // comes leaves an obviously unfinished erasure rather than a register
      // entry claiming a finished one.
      await ctx.scheduler.runAfter(
        0,
        internal.purge.deleteSessionRecords,
        args,
      )
      return null
    }

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
 * Erase one session completely: its objects, then its rows, then the register
 * entry. The one sequence every full erasure runs — the candidate's own
 * request, a recruiter's deletion, an organisation's deletion — so they cannot
 * drift into deleting different things. A session already gone is a success.
 */
export async function eraseSession(
  ctx: ActionCtx,
  sessionId: Id<'sessions'>,
  reason: Exclude<Doc<'purgeLog'>['reason'], 'retention'>,
): Promise<void> {
  const objects = await ctx.runQuery(internal.purge.collectSessionObjects, {
    sessionId,
  })
  if (!objects) return
  // Objects first: a failure here is retried and finds the rows still
  // present. The reverse order would orphan video in the bucket.
  await deleteObjects(objects.keys)
  await ctx.runMutation(internal.purge.deleteSessionRecords, {
    sessionId,
    reason,
    candidateEmailHash: await hashEmail(objects.candidateEmail),
    objectsDeleted: objects.keys.length,
  })
}

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
        supersededKeys: undefined,
      })
    }
    // `purgeAfter` stays. It is the record of which clock ran out, and
    // clearing it would make a purged session indistinguishable from one that
    // never had a clock. `mediaPurgedAt` is what takes the session out of
    // `sessionsDueForPurge`.
    await ctx.db.patch('sessions', args.sessionId, {
      cvKey: undefined,
      coverLetterKey: undefined,
      pendingDocumentKeys: undefined,
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

/** Candidates of the role examined per step. */
const ROLE_SESSION_BATCH = 50

/**
 * Erase `userId`'s assistant threads that read a candidate of `projectId`,
 * scheduled by `leaveTeam` when their seat on its team goes. A tool result is
 * their copy of the candidate; with the seat gone they could no longer read
 * it anywhere else. Found the way erasure finds them — by session, through
 * `chatThreadSessions` — and narrowed to the scope of their threads in that
 * organisation (`${orgId}:${userId}`, lib/agentScope.ts).
 *
 * Runs after the seat's removal commits, so a membership ended in the same
 * transaction is already gone. Does nothing if by then they can see the role
 * anyway — an admin or owner, or someone put back on the team.
 */
export const eraseRoleThreads = internalMutation({
  args: {
    projectId: v.id('projects'),
    userId: v.id('users'),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, { projectId, userId, cursor }) => {
    const project = await ctx.db.get('projects', projectId)
    if (!project) return null
    const member = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_and_user', (q) =>
        q.eq('orgId', project.orgId).eq('userId', userId),
      )
      .unique()
    if (member && (await canSeeProject(ctx, project, userId, member.role))) {
      return null
    }

    const scope = `${project.orgId}:${userId}`
    // One thread often read several candidates of the role: ask its owner once.
    const theirs = new Map<string, boolean>()
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .paginate({ numItems: ROLE_SESSION_BATCH, cursor })
    for (const session of sessions.page) {
      const reads = await ctx.db
        .query('chatThreadSessions')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .collect()
      for (const read of reads) {
        if (!theirs.has(read.threadId)) {
          const thread = await ctx.runQuery(
            components.agent.threads.getThread,
            { threadId: read.threadId },
          )
          theirs.set(read.threadId, thread?.userId === scope)
        }
        if (theirs.get(read.threadId)) await eraseThread(ctx, read)
      }
    }
    if (!sessions.isDone) {
      await ctx.scheduler.runAfter(0, internal.purge.eraseRoleThreads, {
        projectId,
        userId,
        cursor: sessions.continueCursor,
      })
    }
    return null
  },
})
