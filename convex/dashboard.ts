/**
 * The recruiter's home page, in one read.
 *
 * Answers the three questions a recruiter actually opens the app with: what
 * is waiting for me, what is moving, and what has gone quiet. Everything is
 * computed from a bounded recent window — a dashboard must not get slower as
 * an organisation succeeds.
 */

import { v } from 'convex/values'

import { query } from './_generated/server'
import { requireOrgMember } from './lib/auth'
import { effectiveNow } from './lib/clock'
import { filterVisibleProjects } from './lib/projectAccess'

/** How far back the activity figures look. */
const WINDOW_DAYS = 30
const RECENT_CAP = 400

export const overview = query({
  args: { orgId: v.id('organizations'), now: v.number() },
  handler: async (ctx, { orgId, now }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    const since = effectiveNow(now) - WINDOW_DAYS * 24 * 60 * 60 * 1000

    const allProjects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(RECENT_CAP)
    const projects = await filterVisibleProjects(
      ctx,
      allProjects,
      user._id,
      member.role,
    )
    const visibleProjectIds = new Set(projects.map((project) => project._id))

    const sessions = (
      await ctx.db
        .query('sessions')
        .withIndex('by_org', (q) => q.eq('orgId', orgId))
        .order('desc')
        .take(RECENT_CAP)
    ).filter((session) => visibleProjectIds.has(session.projectId))

    // "Awaiting your review" is the number that should decide whether a
    // recruiter opens the app today: finished, analysed, and nobody has said
    // anything about it yet.
    let awaitingReview = 0
    const recent: Array<{
      sessionId: string
      candidateName: string
      projectTitle: string
      completedAt: number
      score: number | null
      decision: string | null
    }> = []

    // No per-session `reports` lookup. This is a reactive query: it re-runs
    // on every write to any session of the organisation — so on every
    // `markSegmentUploaded` of every candidate mid-interview — and it used to
    // take up to 400 extra indexed reads with it, for every open tab. The
    // headline is denormalised onto the session by the queue that writes the
    // report (see convex/pipeline.ts).
    for (const session of sessions) {
      if (session.status !== 'completed') continue
      const scored = session.overallScore !== undefined
      if (scored && !session.recruiterDecision) awaitingReview += 1
      if (recent.length < 8 && session.completedAt) {
        recent.push({
          sessionId: session._id,
          candidateName: session.candidateName,
          projectTitle:
            projects.find((project) => project._id === session.projectId)
              ?.title ?? '',
          completedAt: session.completedAt,
          score: session.overallScore ?? null,
          decision: session.recruiterDecision ?? null,
        })
      }
    }

    const inWindow = sessions.filter((session) => session.invitedAt >= since)

    return {
      activeRoles: projects.filter((project) => project.status === 'active')
        .length,
      draftRoles: projects.filter((project) => project.status === 'draft').length,
      awaitingReview,
      invitedInWindow: inWindow.length,
      completedInWindow: inWindow.filter(
        (session) => session.status === 'completed',
      ).length,
      inProgress: sessions.filter((session) => session.status === 'in_progress')
        .length,
      pending: sessions.filter((session) => session.status === 'pending').length,
      decisions: {
        rejected: sessions.filter((s) => s.recruiterDecision === 'rejected')
          .length,
        maybe: sessions.filter((s) => s.recruiterDecision === 'maybe').length,
        shortlisted: sessions.filter((s) => s.recruiterDecision === 'shortlisted')
          .length,
        hired: sessions.filter((s) => s.recruiterDecision === 'hired').length,
      },
      recent,
      windowDays: WINDOW_DAYS,
    }
  },
})
