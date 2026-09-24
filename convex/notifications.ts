import { v } from 'convex/values'

import { internalMutation, mutation } from './_generated/server'
import { requireAppUser } from './lib/auth'
import { RESEND_FROM, resend } from './email'
import { consumeLimit } from './rateLimiters'
import { passwordChangedEmail, reportReadyEmail } from './emailTemplates'
import type { Id } from './_generated/dataModel'

const siteUrl = process.env.SITE_URL!

/**
 * Post-event notifications. Called after the security-critical state change
 * has already succeeded — these emails inform the user; they are not part of
 * the action itself, so failures here must never roll back the underlying op.
 *
 * Public mutations rather than internalMutations so the client can fire them
 * immediately after a BA call succeeds. The recipient address is always
 * read from the authenticated user (server-side), never from client input —
 * so the endpoint cannot be abused to spam arbitrary inboxes.
 */

export const notifyPasswordChanged = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx)
    await consumeLimit(ctx, 'passwordChangedNotify', user._id)
    const resetUrl = `${siteUrl}/forgot-password`
    const { subject, html, text } = passwordChangedEmail({
      locale: user.preferredLanguage ?? 'en',
      email: user.email,
      resetUrl,
    })
    await resend.sendEmail(ctx, {
      from: RESEND_FROM,
      to: user.email,
      subject,
      html,
      text,
    })
  },
})

/**
 * Tell the people who can act on it that a report exists.
 *
 * Internal, and the recipient list is derived server-side from org membership
 * and project sharing — never from an argument. Returns whether anything was
 * sent, so the pipeline can log "skipped" rather than "succeeded" when a role
 * has no audience.
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

    // Who sees the role is who hears about it: a restricted role notifies only
    // the people named on it, plus its creator.
    const recipients = new Set<Id<'users'>>([project.createdBy])
    if (project.restricted) {
      const shares = await ctx.db
        .query('projectShares')
        .withIndex('by_project', (q) => q.eq('projectId', project._id))
        .collect()
      for (const share of shares) recipients.add(share.userId)
    } else {
      const members = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org', (q) => q.eq('orgId', session.orgId))
        .take(200)
      for (const member of members) recipients.add(member.userId)
    }

    const reportUrl = `${siteUrl}/app/${org?.slug ?? ''}/candidates/${sessionId}`
    let sent = false
    for (const userId of recipients) {
      // Membership is re-checked at send time: `createdBy` and a share row are
      // attributions inside the org, never a grant that outlives removal.
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', session.orgId).eq('userId', userId),
        )
        .unique()
      if (!membership) continue
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
