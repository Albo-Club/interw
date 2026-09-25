/**
 * The recruiter's home page, in one read.
 *
 * Answers the three questions a recruiter actually opens the app with: what
 * is waiting for me, what is moving, and what has gone quiet. Every figure is
 * a bounded scan — a dashboard must not get slower as an organisation
 * succeeds — and a scan that hits its bound says so (Back M3): the figure is
 * then a floor, rendered "400+", never a smaller number passed off as the
 * total. Each figure reads the index that answers it rather than one shared
 * window of the last 400 sessions, which made "decisions so far" and "invited
 * in the last 30 days" shrink as the organisation grew.
 */

import { v } from 'convex/values'

import { query } from './_generated/server'
import { requireOrgMember } from './lib/auth'
import { effectiveNow } from './lib/clock'
import { canSeeProject } from './lib/projectAccess'
import type { Doc, Id } from './_generated/dataModel'

/** How far back the activity figures look. */
const WINDOW_DAYS = 30
/** Rows one figure may read. */
const SCAN_CAP = 400
const RECENT_COUNT = 8

export const overview = query({
  args: { orgId: v.id('organizations'), now: v.number() },
  handler: async (ctx, { orgId, now }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    // The caller's clock keeps the window reactive; it does not choose it.
    // See convex/lib/clock.ts.
    const since = effectiveNow(now) - WINDOW_DAYS * 24 * 60 * 60 * 1000

    // One visibility check per role, shared by the role counts and the
    // session figures that all name the same few roles.
    const seen = new Map<Id<'projects'>, boolean>()
    async function canSee(project: Doc<'projects'>) {
      let ok = seen.get(project._id)
      if (ok === undefined) {
        ok = await canSeeProject(ctx, project, user._id, member.role)
        seen.set(project._id, ok)
      }
      return ok
    }
    async function visible(sessions: Array<Doc<'sessions'>>) {
      const kept: Array<{ session: Doc<'sessions'>; project: Doc<'projects'> }> =
        []
      for (const session of sessions) {
        const project = await ctx.db.get('projects', session.projectId)
        if (project && (await canSee(project))) kept.push({ session, project })
      }
      return kept
    }

    const roleCounts = await Promise.all(
      (['active', 'draft'] as const).map(async (status) => {
        const rows = await ctx.db
          .query('projects')
          .withIndex('by_org_and_status', (q) =>
            q.eq('orgId', orgId).eq('status', status),
          )
          .take(SCAN_CAP)
        let count = 0
        for (const project of rows) if (await canSee(project)) count += 1
        return { count, capped: rows.length === SCAN_CAP }
      }),
    )

    // Invited in the window: a range that stops at the window's edge, rather
    // than whatever span the last 400 sessions happen to cover.
    const invitedRows = await ctx.db
      .query('sessions')
      .withIndex('by_org_and_invited', (q) =>
        q.eq('orgId', orgId).gte('invitedAt', since),
      )
      .take(SCAN_CAP)
    const invited = await visible(invitedRows)

    // Everything that needs a finished interview reads finished interviews
    // only: pending and in-flight sessions no longer crowd them out.
    const completedRows = await ctx.db
      .query('sessions')
      .withIndex('by_org_and_status', (q) =>
        q.eq('orgId', orgId).eq('status', 'completed'),
      )
      .order('desc')
      .take(SCAN_CAP)
    const completed = await visible(completedRows)

    const decisions = { rejected: 0, maybe: 0, shortlisted: 0, hired: 0 }
    let awaitingReview = 0
    for (const { session } of completed) {
      if (session.recruiterDecision) decisions[session.recruiterDecision] += 1
      // "Awaiting your review" is the number that should decide whether a
      // recruiter opens the app today: finished, analysed, and nobody has
      // said anything about it yet. The score is denormalised onto the
      // session (see convex/pipeline.ts): reading `reports` per row here made
      // this reactive query an N+1 on every candidate's upload.
      if (session.overallScore !== undefined && !session.recruiterDecision) {
        awaitingReview += 1
      }
    }

    const recent = completed
      .filter(({ session }) => session.completedAt !== undefined)
      .sort((a, b) => (b.session.completedAt ?? 0) - (a.session.completedAt ?? 0))
      .slice(0, RECENT_COUNT)
      .map(({ session, project }) => ({
        sessionId: session._id,
        candidateName: session.candidateName,
        projectTitle: project.title,
        completedAt: session.completedAt ?? 0,
        score: session.overallScore ?? null,
        decision: session.recruiterDecision ?? null,
      }))

    return {
      activeRoles: roleCounts[0].count,
      draftRoles: roleCounts[1].count,
      awaitingReview,
      invitedInWindow: invited.length,
      completedInWindow: invited.filter(
        ({ session }) => session.status === 'completed',
      ).length,
      decisions,
      recent,
      windowDays: WINDOW_DAYS,
      /** Which figures are floors: their scan stopped at `SCAN_CAP` rows. */
      capped: {
        roles: roleCounts.some((roles) => roles.capped),
        invited: invitedRows.length === SCAN_CAP,
        completed: completedRows.length === SCAN_CAP,
      },
    }
  },
})
