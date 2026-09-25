import { v } from 'convex/values'

import { internalMutation } from './_generated/server'
import { RESEND_FROM, resend } from './email'
import { rateLimiter } from './rateLimiters'
import { passwordChangedEmail, reportReadyEmail } from './emailTemplates'
import { isCreator, seesEverything } from './lib/projectAccess'
import type { Id } from './_generated/dataModel'

const siteUrl = process.env.SITE_URL!

/**
 * "Your password was changed" — or, with `added`, "a password was added".
 *
 * Sent by the server once the change itself has succeeded (Better Auth's
 * change-password and reset hooks, `users.setPassword`), so no client can
 * skip it and none can trigger it without a change. It informs; it is not
 * part of the change, which is already committed and must still read as a
 * success — so past the per-user budget it logs and returns instead of
 * throwing.
 */
export const passwordChanged = internalMutation({
  args: { betterAuthId: v.string(), added: v.optional(v.boolean()) },
  handler: async (ctx, { betterAuthId, added }): Promise<boolean> => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', betterAuthId))
      .unique()
    if (!user) return false
    const { ok } = await rateLimiter.limit(ctx, 'passwordChangedNotify', {
      key: user._id,
    })
    if (!ok) {
      console.warn('[password-changed-notice] rate_limited', {
        userId: user._id,
      })
      return false
    }
    const { subject, html, text } = passwordChangedEmail({
      locale: user.preferredLanguage ?? 'en',
      email: user.email,
      added: added ?? false,
      resetUrl: `${siteUrl}/forgot-password`,
      sessionsUrl: `${siteUrl}/app/me?tab=sessions`,
    })
    await resend.sendEmail(ctx, {
      from: RESEND_FROM,
      to: user.email,
      subject,
      html,
      text,
    })
    return true
  },
})

/**
 * Tell the role's team that a report exists.
 *
 * Internal, and the recipient list is derived server-side from the role's
 * team and org membership — never from an argument. Returns whether anything
 * was sent, so the pipeline can log "skipped" rather than "succeeded" when a
 * role has no audience.
 */
export const sendReportReady = internalMutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }): Promise<boolean> => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return false

    // Idempotent: the pool may retry this job, and a recruiter should not get
    // the same report emailed to them twice.
    //
    // Asked of the session's own rows, not of the organisation's last 200
    // emails. One bulk campaign of 300 invitations used to push the
    // `report-ready` row out of that window, and the next retry of this job
    // sent the whole report round again.
    const alreadySent = await ctx.db
      .query('emailLog')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    if (alreadySent.some((entry) => entry.template === 'report-ready')) {
      return false
    }

    const project = await ctx.db.get('projects', session.projectId)
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (!project || !report) return false
    const org = await ctx.db.get('organizations', session.orgId)

    // The role's team and nobody else: its creator plus the colleagues they
    // chose. Admins and owners see every role but are only mailed about the
    // ones they follow — an org of 40 used to get 40 emails per candidate.
    const shares = await ctx.db
      .query('projectShares')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    const onTeam = new Set(shares.map((row) => row.userId))
    const team = new Set<Id<'users'>>([project.createdBy, ...onTeam])

    // Membership is checked here, at send time: `createdBy` and a team row are
    // attributions inside the org, never a grant that outlives removal.
    let audience = (
      await Promise.all(
        [...team].map((userId) =>
          ctx.db
            .query('organizationMembers')
            .withIndex('by_org_and_user', (q) =>
              q.eq('orgId', session.orgId).eq('userId', userId),
            )
            .unique(),
        ),
      )
    )
      .filter((member) => member !== null)
      // A creator re-invited after removal is not the creator of this
      // membership: only a team row puts them back on the list (T17-2).
      .filter((member) => onTeam.has(member.userId) || isCreator(project, member))
    // A creator who left alone on their role would leave its reports landing
    // with nobody told. The admins, who can already see it, inherit it.
    if (audience.length === 0) {
      audience = (
        await ctx.db
          .query('organizationMembers')
          .withIndex('by_org', (q) => q.eq('orgId', session.orgId))
          .collect()
      ).filter((member) => seesEverything(member.role))
    }

    const reportUrl = `${siteUrl}/app/${org?.slug ?? ''}/candidates/${sessionId}`
    let sent = false
    for (const { userId } of audience) {
      const user = await ctx.db.get('users', userId)
      if (!user) continue
      const { subject, html, text } = reportReadyEmail({
        locale: user.preferredLanguage ?? project.language,
        candidateName: session.candidateName,
        jobTitle: project.jobTitle ?? project.title,
        score: report.overallScore,
        recommendation: report.recommendation,
        reportUrl,
      })
      const providerId = await resend.sendEmail(ctx, {
        from: RESEND_FROM,
        to: user.email,
        subject,
        html,
        text,
      })
      // The provider id is what the delivery webhook matches on later, so the
      // row has to carry it from the moment it is written.
      await ctx.db.insert('emailLog', {
        orgId: session.orgId,
        template: 'report-ready',
        recipient: user.email,
        status: 'sent',
        providerId,
        sessionId,
        createdAt: Date.now(),
      })
      sent = true
    }
    return sent
  },
})
