/**
 * Organisation erasure: what runs after an owner deletes an organisation
 * (`organizations.requestDeletion`, which froze it first).
 *
 * One bounded phase per invocation, each handing on to the next, in this
 * order:
 *
 *   sessions      every candidate, through the same core as every other
 *                 erasure (convex/purge.ts) — objects, then rows, then a
 *                 register entry with reason `org_delete`
 *   projects      the recruiter's own recordings, then the roles, questions,
 *                 criteria and project shares that named them
 *   threads       every assistant thread scoped to the organisation, including
 *                 those that never read a candidate and so have no
 *                 `chatThreadSessions` row for the session core to find
 *   leftovers     invitations, report shares, email and job logs
 *   organization  memberships, the logo, and last the organisation row
 *
 * Every phase is idempotent, and the organisation row is the durable state:
 * while it exists with `deletingAt`, the erasure is unfinished. `purgeLog` is
 * kept — it is the proof the erasure happened, and outlives the organisation
 * it names.
 */

import { v } from 'convex/values'

import { internalAction, internalMutation, internalQuery } from './_generated/server'
import { components, internal } from './_generated/api'
import { deleteObjects } from './lib/objectStore'
import { introSlotKeys, questionSlotKeys } from './media'
import { release } from './lib/storage'
import { eraseSession } from './purge'
import type { ActionCtx } from './_generated/server'
import type { Id } from './_generated/dataModel'

/** Sessions per pass, as in the retention purge: bounded by the action. */
const SESSION_BATCH = 25
/** Roles per pass. Each carries its questions, criteria and shares. */
const PROJECT_BATCH = 10
/** Rows per table per pass, as in `purge.deleteSessionRecords`. */
const ROW_BATCH = 100
/** Thread scopes listed per pass. */
const THREAD_PAGE = 100
/** A failed pass (the bucket is down, say) is tried again after this. */
const RETRY_MS = 5 * 60 * 1000

const phaseValidator = v.union(
  v.literal('sessions'),
  v.literal('projects'),
  v.literal('threads'),
  v.literal('leftovers'),
  v.literal('organization'),
)
type Phase = typeof phaseValidator.type
type Next = { phase: Phase; cursor?: string } | null

export const step = internalAction({
  args: {
    orgId: v.id('organizations'),
    phase: v.optional(phaseValidator),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { orgId, phase = 'sessions', cursor }) => {
    // Gone means done; not frozen means nobody asked. Either way, nothing to
    // do — which is what makes a replay of a finished erasure a no-op.
    if (!(await ctx.runQuery(internal.orgErasure.isDeleting, { orgId }))) {
      return null
    }
    let next: Next
    try {
      next = await PHASES[phase](ctx, orgId, cursor)
    } catch (error) {
      // Nothing retries a scheduled action on its own, and a frozen
      // organisation nobody can reach must not stay half-erased.
      console.error('[org-erasure] failed', {
        orgId,
        phase,
        error: String(error),
      })
      await ctx.scheduler.runAfter(RETRY_MS, internal.orgErasure.step, {
        orgId,
        phase,
        cursor,
      })
      return null
    }
    if (next) {
      await ctx.scheduler.runAfter(0, internal.orgErasure.step, {
        orgId,
        ...next,
      })
    } else {
      console.log('[org-erasure] done', { orgId })
    }
    return null
  },
})

function logPass(orgId: Id<'organizations'>, phase: Phase, count: number) {
  console.log('[org-erasure]', { orgId, phase, count })
}

const PHASES: Record<
  Phase,
  (
    ctx: ActionCtx,
    orgId: Id<'organizations'>,
    cursor: string | undefined,
  ) => Promise<Next>
> = {
  sessions: async (ctx, orgId) => {
    const sessionIds = await ctx.runQuery(internal.orgErasure.sessionBatch, {
      orgId,
    })
    for (const sessionId of sessionIds) {
      await eraseSession(ctx, sessionId, 'org_delete')
    }
    logPass(orgId, 'sessions', sessionIds.length)
    // A session with more rows than one pass stays until its own erasure
    // finishes, and is simply picked up again: every step above is a replay.
    return { phase: sessionIds.length > 0 ? 'sessions' : 'projects' }
  },

  projects: async (ctx, orgId) => {
    const projects = await ctx.runQuery(internal.orgErasure.projectBatch, {
      orgId,
    })
    logPass(orgId, 'projects', projects.length)
    if (projects.length === 0) return { phase: 'threads' }
    await deleteObjects(projects.flatMap((project) => project.keys))
    await ctx.runMutation(internal.orgErasure.deleteProjects, {
      projectIds: projects.map((project) => project.projectId),
    })
    return { phase: 'projects' }
  },

  threads: async (ctx, orgId, cursor) => {
    // The component lists scopes, not organisations; `${orgId}:` is the
    // organisation's part of every scope (convex/lib/agentScope.ts).
    const scopes = await ctx.runQuery(
      components.agent.users.listUsersWithThreads,
      { paginationOpts: { numItems: THREAD_PAGE, cursor: cursor ?? null } },
    )
    const ours = scopes.page.filter((scope) => scope.startsWith(`${orgId}:`))
    for (const userId of ours) {
      // Pages through the scope's threads on the component's own schedule.
      await ctx.runMutation(components.agent.users.deleteAllForUserIdAsync, {
        userId,
      })
    }
    logPass(orgId, 'threads', ours.length)
    return scopes.isDone
      ? { phase: 'leftovers' }
      : { phase: 'threads', cursor: scopes.continueCursor }
  },

  leftovers: async (ctx, orgId) => {
    const count = await ctx.runMutation(internal.orgErasure.deleteLeftovers, {
      orgId,
    })
    logPass(orgId, 'leftovers', count)
    return { phase: count > 0 ? 'leftovers' : 'organization' }
  },

  organization: async (ctx, orgId) => {
    const count = await ctx.runMutation(
      internal.orgErasure.deleteOrganization,
      { orgId },
    )
    logPass(orgId, 'organization', count)
    return count > 0 ? { phase: 'organization' } : null
  },
}

export const isDeleting = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    const org = await ctx.db.get('organizations', orgId)
    return org?.deletingAt !== undefined
  },
})

export const sessionBatch = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    const sessions = await ctx.db
      .query('sessions')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(SESSION_BATCH)
    return sessions.map((session) => session._id)
  },
})

/** A batch of roles, with every object key their rows name. */
export const projectBatch = internalQuery({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(PROJECT_BATCH)
    return await Promise.all(
      projects.map(async (project) => {
        const questions = await ctx.db
          .query('questions')
          .withIndex('by_project', (q) => q.eq('projectId', project._id))
          .collect()
        // Rows name what was attached; the slot keys cover what was
        // uploaded and never attached (T17-5).
        const keys = [
          ...new Set(
            [
              project.introMediaKey,
              ...introSlotKeys(project),
              ...questions.flatMap((question) => [
                question.mediaKey,
                ...questionSlotKeys(question),
              ]),
            ].filter((key): key is string => key !== undefined),
          ),
        ]
        return { projectId: project._id, keys }
      }),
    )
  },
})

/** Called once the objects the rows name are gone — never before. */
export const deleteProjects = internalMutation({
  args: { projectIds: v.array(v.id('projects')) },
  handler: async (ctx, { projectIds }) => {
    for (const projectId of projectIds) {
      for (const table of ['questions', 'criteria', 'projectShares'] as const) {
        const rows = await ctx.db
          .query(table)
          .withIndex('by_project', (q) => q.eq('projectId', projectId))
          .collect()
        for (const row of rows) await ctx.db.delete(table, row._id)
      }
      // Already gone if this is a replay of a pass that committed.
      if (await ctx.db.get('projects', projectId)) {
        await ctx.db.delete('projects', projectId)
      }
    }
    return null
  },
})

/**
 * Rows that name the organisation and no session. Returns how many it
 * deleted; zero means none are left. `purgeLog` is deliberately not here.
 */
export const deleteLeftovers = internalMutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }): Promise<number> => {
    const invitations = await ctx.db
      .query('invitations')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(ROW_BATCH)
    for (const row of invitations) await ctx.db.delete('invitations', row._id)

    const reportShares = await ctx.db
      .query('reportShares')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(ROW_BATCH)
    for (const row of reportShares) await ctx.db.delete('reportShares', row._id)

    const emails = await ctx.db
      .query('emailLog')
      .withIndex('by_org_and_created', (q) => q.eq('orgId', orgId))
      .take(ROW_BATCH)
    for (const row of emails) await ctx.db.delete('emailLog', row._id)

    const jobs = await ctx.db
      .query('jobLog')
      .withIndex('by_org_and_at', (q) => q.eq('orgId', orgId))
      .take(ROW_BATCH)
    for (const row of jobs) await ctx.db.delete('jobLog', row._id)

    return invitations.length + reportShares.length + emails.length + jobs.length
  },
})

/**
 * The memberships, then the logo and the organisation row itself, in the
 * pass that finds no membership left. Returns how many memberships it
 * deleted; zero means the organisation is gone.
 */
export const deleteOrganization = internalMutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }): Promise<number> => {
    const org = await ctx.db.get('organizations', orgId)
    if (!org) return 0

    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(ROW_BATCH)
    for (const member of members) {
      // The slug is free once the row goes, and may name someone else's
      // organisation next.
      const prefs = await ctx.db
        .query('userPrefs')
        .withIndex('by_user', (q) => q.eq('userId', member.userId))
        .unique()
      if (prefs?.lastOrgSlug === org.slug) {
        await ctx.db.patch('userPrefs', prefs._id, { lastOrgSlug: undefined })
      }
      await ctx.db.delete('organizationMembers', member._id)
    }
    if (members.length > 0) return members.length

    await release(ctx, org.logoStorageId, orgId)
    await ctx.db.delete('organizations', orgId)
    return 0
  },
})
