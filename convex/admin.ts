import { ConvexError, v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'
import { internalMutation, mutation, query } from './_generated/server'
import { components, internal } from './_generated/api'
import { requireSuperAdmin } from './lib/auth'
import type {
  FunctionReference,
  GenericMutationCtx,
  GenericQueryCtx,
} from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

/**
 * One-shot dev cleanup. Run via:
 *   pnpm exec convex run admin:purgeExcept '{"keepEmail":"x@y.com"}'
 *
 * Nukes:
 *  - All Convex app data except the matching user (and their org memberships are also nuked — orgs are wiped fully)
 *  - All Better Auth users (and dependent sessions/accounts via cascade in the BA component) except the matching one
 */
export const purgeExcept = internalMutation({
  args: { keepEmail: v.string() },
  handler: async (ctx, { keepEmail }) => {
    const target = keepEmail.toLowerCase().trim()

    for (const table of [
      'invitations',
      'organizationMembers',
      'organizations',
      'userPrefs',
    ] as const) {
      const rows = await ctx.db.query(table).collect()
      for (const r of rows) await ctx.db.delete(table, r._id)
    }

    let keptConvexUserId: string | null = null
    const users = await ctx.db.query('users').collect()
    for (const u of users) {
      if (u.email.toLowerCase() === target) {
        keptConvexUserId = u._id
      } else {
        await ctx.db.delete("users", u._id)
      }
    }

    let cursor: string | null = null
    let baDeleted = 0
    const adapter = (
      components as unknown as {
        betterAuth: {
          adapter: {
            findMany: FunctionReference<'query', 'internal'>
            deleteOne: FunctionReference<'mutation', 'internal'>
          }
        }
      }
    ).betterAuth.adapter

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const result = (await ctx.runQuery(adapter.findMany, {
        model: 'user',
        paginationOpts: { numItems: 100, cursor },
      })) as {
        page: Array<{ _id: string; email?: string }>
        isDone: boolean
        continueCursor: string
      }
      for (const u of result.page) {
        if ((u.email ?? '').toLowerCase() !== target) {
          await ctx.runMutation(adapter.deleteOne, {
            input: {
              model: 'user',
              where: [{ field: '_id', operator: 'eq', value: u._id }],
            },
          })
          baDeleted += 1
        }
      }
      if (result.isDone) break
      cursor = result.continueCursor
    }

    return {
      keptConvexUserId,
      baUsersDeleted: baDeleted,
    }
  },
})

/**
 * Rows one deployment-wide figure may read (Back F8). There is no count
 * operator, and these used to be four whole-table `.collect()` calls — the
 * screen would have stopped loading well before the product got big. A figure
 * that hits the bound is reported as capped: "1000+" is a true statement.
 */
const OVERVIEW_CAP = 1000

export const overview = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx)
    const [users, orgs, members, invitations] = await Promise.all([
      ctx.db.query('users').take(OVERVIEW_CAP),
      ctx.db.query('organizations').take(OVERVIEW_CAP),
      ctx.db.query('organizationMembers').take(OVERVIEW_CAP),
      ctx.db.query('invitations').take(OVERVIEW_CAP),
    ])
    const counted = (rows: Array<unknown>, count = rows.length) => ({
      count,
      capped: rows.length === OVERVIEW_CAP,
    })
    return {
      users: counted(users),
      orgs: counted(orgs),
      members: counted(members),
      pendingInvitations: counted(
        invitations,
        invitations.filter((i) => !i.acceptedAt).length,
      ),
    }
  },
})

export const listOrgs = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireSuperAdmin(ctx)
    const page = await ctx.db
      .query('organizations')
      .order('desc')
      .paginate(paginationOpts)
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (org) => {
          const members = await ctx.db
            .query('organizationMembers')
            .withIndex('by_org', (q) => q.eq('orgId', org._id))
            .collect()
          return {
            _id: org._id,
            slug: org.slug,
            name: org.name,
            memberCount: members.length,
            createdAt: org.createdAt,
          }
        }),
      ),
    }
  },
})

export const listUsers = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => {
    await requireSuperAdmin(ctx)
    const page = await ctx.db
      .query('users')
      .order('desc')
      .paginate(paginationOpts)
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (u) => {
          const memberships = await ctx.db
            .query('organizationMembers')
            .withIndex('by_user', (q) => q.eq('userId', u._id))
            .collect()
          return {
            _id: u._id,
            email: u.email,
            name: u.name ?? null,
            superAdmin: u.superAdmin,
            orgCount: memberships.length,
            createdAt: u.createdAt,
          }
        }),
      ),
    }
  },
})

export const setSuperAdmin = mutation({
  args: { userId: v.id('users'), value: v.boolean() },
  handler: async (ctx, { userId, value }) => {
    const me = await requireSuperAdmin(ctx)
    if (userId === me._id && !value) {
      // Two rows answer "is anyone else a super-admin?" — the caller is one.
      const admins = await ctx.db
        .query('users')
        .withIndex('by_superAdmin', (q) => q.eq('superAdmin', true))
        .take(2)
      if (admins.every((u) => u._id === me._id)) {
        throw new ConvexError('last_super_admin')
      }
    }
    const target = await ctx.db.get("users", userId)
    if (!target) throw new ConvexError('not_found')
    if (target.superAdmin === value) return null
    await ctx.db.patch("users", userId, { superAdmin: value })
    return null
  },
})

/* ───────────────────────── Pipeline health ──────────────────────────────── */

/**
 * Per-bucket scan cap. There is no count operator, so a figure is a bounded
 * scan or it is nothing. Saturating the cap is reported rather than hidden:
 * "200+" is a true statement, "200" would not be.
 */
const COUNT_CAP = 200
/** How many finished-but-unreported sessions the screen will name. */
const STUCK_CAP = 25

const DAY_MS = 24 * 60 * 60 * 1000

async function countJobs(
  ctx: GenericQueryCtx<DataModel>,
  step: Doc<'jobLog'>['step'],
  outcome: Doc<'jobLog'>['outcome'],
  since: number,
): Promise<{ count: number; capped: boolean }> {
  const rows = await ctx.db
    .query('jobLog')
    .withIndex('by_step_and_outcome', (q) =>
      q.eq('step', step).eq('outcome', outcome).gte('at', since),
    )
    .take(COUNT_CAP)
  return { count: rows.length, capped: rows.length === COUNT_CAP }
}

/**
 * Whether the pipeline is working, for the one person who can do something
 * about it.
 *
 * `jobLog.by_step_and_outcome` was built for exactly this and was read by
 * nothing: an expired provider key produced four failed transcriptions per
 * interview, in a table nobody looked at, and the first signal was a recruiter
 * asking where a report had got to.
 */
export const pipelineHealth = query({
  args: {},
  handler: async (ctx) => {
    await requireSuperAdmin(ctx)
    const now = Date.now()
    const steps = ['transcribe', 'report', 'notify'] as const
    const outcomes = ['succeeded', 'failed', 'skipped'] as const

    const windows = await Promise.all(
      [1, 7].map(async (days) => {
        const since = now - days * DAY_MS
        const counts = await Promise.all(
          steps.map(async (step) => ({
            step,
            outcomes: Object.fromEntries(
              await Promise.all(
                outcomes.map(async (outcome) => [
                  outcome,
                  await countJobs(ctx, step, outcome, since),
                ]),
              ),
            ) as Record<
              (typeof outcomes)[number],
              { count: number; capped: boolean }
            >,
          })),
        )
        return { days, counts }
      }),
    )

    // Finished interviews with no assessment. The denormalised headline
    // answers it without a lookup; the ones that look stuck are confirmed
    // against `reports`, so sessions completed before that field existed are
    // not reported as broken.
    const completed = await ctx.db
      .query('sessions')
      .withIndex('by_status_and_completed', (q) => q.eq('status', 'completed'))
      .order('desc')
      .take(100)
    const stuck: Array<{
      sessionId: Id<'sessions'>
      candidateName: string
      completedAt: number | null
      settled: number
      expected: number
    }> = []
    for (const session of completed) {
      if (stuck.length >= STUCK_CAP) break
      if (session.overallScore !== undefined) continue
      const report = await ctx.db
        .query('reports')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .unique()
      if (report) continue
      stuck.push({
        sessionId: session._id,
        candidateName: session.candidateName,
        completedAt: session.completedAt ?? null,
        settled: session.segmentsSettled ?? 0,
        expected: session.segmentsExpected ?? 0,
      })
    }

    return { windows, stuck }
  },
})

/**
 * How long a report claim is trusted to mean "a job is running". The job
 * releases it when it ends; this bound only frees a claim whose job ended
 * without doing so. Four attempts of two two-minute calls, plus backoff, fit
 * well inside it.
 */
const REPORT_CLAIM_TTL_MS = 60 * 60 * 1000

/**
 * Run a stuck session's pipeline again, on behalf of `actorId`.
 *
 * Not a catch-up script: it is a person naming one session and saying "go
 * again", it is written to the same log as everything else that happened to
 * that session, and it is idempotent — `onSessionCompleted` keeps the
 * transcripts it already has, leaves the answers still in flight to the jobs
 * already running them, gives another real attempt to the answers that failed
 * for good, and re-enters the fan-in from there.
 *
 * Shared by the operator's `relaunchSession` below and the recruiter's
 * `reports.relaunch`: who may ask differs, what asking does must not.
 */
export async function relaunchPipeline(
  ctx: GenericMutationCtx<DataModel>,
  session: Doc<'sessions'>,
  actorId: Id<'users'>,
): Promise<void> {
  if (session.status !== 'completed') {
    throw new ConvexError('session_not_completed')
  }
  // A report job holds the claim until it ends. Relaunching under it would
  // reset the claim and queue a second, paid completion beside the first.
  const claim = session.reportJobEnqueuedAt
  if (claim !== undefined && Date.now() - claim < REPORT_CLAIM_TTL_MS) {
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .unique()
    if (!report) throw new ConvexError('report_in_progress')
  }

  await ctx.db.insert('jobLog', {
    orgId: session.orgId,
    sessionId: session._id,
    step: 'relaunch',
    outcome: 'started',
    attempt: 1,
    // The id, not the address: recruiters read this log back.
    actorId,
    at: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.pipeline.onSessionCompleted, {
    sessionId: session._id,
  })
}

/** The operator's relaunch, from the pipeline health screen. */
export const relaunchSession = mutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const me = await requireSuperAdmin(ctx)
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    await relaunchPipeline(ctx, session, me._id)
    return null
  },
})
