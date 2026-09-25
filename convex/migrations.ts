/**
 * One-off data migrations that run themselves, from a cron, and then stop.
 *
 * Not a pipeline repair: CLAUDE.md forbids catch-up scripts for steps the
 * queue should retry, and nothing here retries a lost step. Each migration is
 * a one-time decision about data that already exists, taken by the owner, and
 * it disables itself — a row with `doneAt` makes every later call return at
 * once. Once every deployment shows `doneAt`, the function, its cron and its
 * row can go in a later cleanup.
 */

import { internalMutation } from './_generated/server'
import { components, internal } from './_generated/api'
import type { MutationCtx } from './_generated/server'
import type { Doc } from './_generated/dataModel'

const PURGE_LEGACY_THREADS = 'purgeLegacyAssistantThreads'
/** Threads of one scope examined per step; each schedules one delete. */
const THREAD_BATCH = 50
/** `chatThreadSessions` rows deleted per step. */
const ROW_BUDGET = 500

/**
 * Deletes every assistant thread created before this migration first ran.
 *
 * Erasure finds the threads that read a candidate through the
 * `chatThreadSessions` rows the tools write at read time. Threads from before
 * those rows existed carry none, so erasure cannot find them; the owner chose
 * to delete every one of them rather than keep conversations that may hold a
 * candidate no erasure can reach.
 *
 * `cutoff` is the first run, per deployment. On a deployment that already
 * wrote `chatThreadSessions` rows before this shipped (staging), the threads
 * created in between go too — deliberately: the decision is "every
 * conversation from before", and staging holds test data.
 *
 * The component has no listing of all threads, only of the scopes that own
 * some (`users.listUsersWithThreads`, which reads its threads table, so the
 * scope of a member since removed, or of an organisation since deleted, is
 * listed like any other) and of one scope's threads, oldest first. A pass
 * walks every scope; within one, the threads before `cutoff` are a prefix.
 * A thread with no scope at all is never listed, and the app cannot create
 * one: `chat.createNewThread` is the only creator, and always sets it.
 *
 * Each step handles one bounded batch and schedules the next. A pass that
 * found a legacy thread is followed, at the next cron tick, by another pass —
 * by then the component has finished deleting what the first one handed it —
 * and the migration is done only after a pass that found none. A cron tick
 * landing mid-pass reads and writes the same row, so it advances the same
 * walk rather than starting a second one.
 */
export const purgeLegacyAssistantThreads = internalMutation({
  args: {},
  handler: async (ctx) => {
    const run = await ensureRun(ctx, PURGE_LEGACY_THREADS)
    if (run.doneAt !== undefined) return null

    let { scope, scopesCursor } = run
    if (scope === undefined) {
      const next = await ctx.runQuery(
        components.agent.users.listUsersWithThreads,
        { paginationOpts: { numItems: 1, cursor: scopesCursor ?? null } },
      )
      scope = next.page.at(0)
      scopesCursor = next.continueCursor
      if (scope === undefined) {
        await endPass(ctx, run)
        return null
      }
    }

    const threads = await ctx.runQuery(
      components.agent.threads.listThreadsByUserId,
      {
        userId: scope,
        order: 'asc',
        paginationOpts: {
          numItems: THREAD_BATCH,
          cursor: run.threadsCursor ?? null,
        },
      },
    )
    const legacy = threads.page.filter((t) => t._creationTime < run.cutoff)
    const foundInPass = run.foundInPass || legacy.length > 0

    const rows: Array<Doc<'chatThreadSessions'>> = []
    for (const thread of legacy) {
      if (rows.length === ROW_BUDGET) break
      const reads = await ctx.db
        .query('chatThreadSessions')
        .withIndex('by_thread_and_session', (q) => q.eq('threadId', thread._id))
        .take(ROW_BUDGET - rows.length)
      rows.push(...reads)
    }
    for (const row of rows) {
      await ctx.db.delete('chatThreadSessions', row._id)
    }

    if (rows.length === ROW_BUDGET) {
      // Budget spent: the same batch again, with fewer rows left to delete.
      await ctx.db.patch('migrations', run._id, {
        scope,
        scopesCursor,
        foundInPass,
      })
    } else {
      for (const thread of legacy) {
        await ctx.scheduler.runAfter(
          0,
          components.agent.threads.deleteAllForThreadIdAsync,
          { threadId: thread._id },
        )
      }
      const scopeDone = threads.isDone || legacy.length < threads.page.length
      await ctx.db.patch('migrations', run._id, {
        scope: scopeDone ? undefined : scope,
        scopesCursor,
        threadsCursor: scopeDone ? undefined : threads.continueCursor,
        foundInPass,
      })
    }
    await ctx.scheduler.runAfter(
      0,
      internal.migrations.purgeLegacyAssistantThreads,
      {},
    )
    return null
  },
})

const BACKFILL_CREATOR_SEATS = 'backfillCreatorSeats'
/** Roles examined per step. */
const ROLE_BATCH = 100

/**
 * Gives every existing role its creator's seat as a `projectShares` row.
 *
 * The seat used to be `projects.createdBy` itself, which removal cannot
 * touch: a creator removed and re-invited got every role they had opened back
 * (audit T17-2). `projects.create` now writes the row and nothing reads
 * `createdBy` as a grant, so roles from before need theirs, once. A creator
 * who is no longer a member gets none — removal is exactly what revokes it.
 *
 * One walk over `projects`, a bounded page per step. Idempotent: a role whose
 * creator already holds a seat is left alone, so a tick landing mid-walk, or a
 * step run twice, writes nothing twice.
 */
export const backfillCreatorSeats = internalMutation({
  args: {},
  handler: async (ctx) => {
    const run = await ensureRun(ctx, BACKFILL_CREATOR_SEATS)
    if (run.doneAt !== undefined) return null

    const roles = await ctx.db.query('projects').paginate({
      numItems: ROLE_BATCH,
      cursor: run.projectsCursor ?? null,
    })
    for (const project of roles.page) {
      const member = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', project.orgId).eq('userId', project.createdBy),
        )
        .unique()
      if (!member) continue
      const seat = await ctx.db
        .query('projectShares')
        .withIndex('by_project_and_user', (q) =>
          q.eq('projectId', project._id).eq('userId', project.createdBy),
        )
        .unique()
      if (seat) continue
      await ctx.db.insert('projectShares', {
        orgId: project.orgId,
        projectId: project._id,
        userId: project.createdBy,
        grantedBy: project.createdBy,
        grantedAt: project.createdAt,
      })
    }

    if (roles.isDone) {
      console.log(`[migrations] ${run.name} done`)
      await ctx.db.patch('migrations', run._id, {
        doneAt: Date.now(),
        projectsCursor: undefined,
      })
      return null
    }
    await ctx.db.patch('migrations', run._id, {
      projectsCursor: roles.continueCursor,
    })
    await ctx.scheduler.runAfter(0, internal.migrations.backfillCreatorSeats, {})
    return null
  },
})

async function ensureRun(
  ctx: MutationCtx,
  name: string,
): Promise<Doc<'migrations'>> {
  const run = await ctx.db
    .query('migrations')
    .withIndex('by_name', (q) => q.eq('name', name))
    .unique()
  if (run) return run
  const id = await ctx.db.insert('migrations', { name, cutoff: Date.now() })
  return (await ctx.db.get('migrations', id))!
}

/** A pass that found nothing is the proof that nothing remains. */
async function endPass(
  ctx: MutationCtx,
  run: Doc<'migrations'>,
): Promise<void> {
  if (run.foundInPass) {
    console.log(`[migrations] ${run.name} pass-found-legacy`)
    await ctx.db.patch('migrations', run._id, {
      scopesCursor: undefined,
      foundInPass: undefined,
    })
    return
  }
  console.log(`[migrations] ${run.name} done`)
  await ctx.db.patch('migrations', run._id, { doneAt: Date.now() })
}
