import { v } from 'convex/values'

import { internalMutation, mutation } from './_generated/server'
import { requireAppUser } from './lib/auth'
import { RESEND_FROM, resend } from './email'
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
    const alreadySent = await ctx.db
      .query('emailLog')
      .withIndex('by_org_and_created', (q) => q.eq('orgId', session.orgId))
      .order('desc')
      .take(200)
    if (
      alreadySent.some(
        (entry) =>
          entry.sessionId === sessionId && entry.template === 'report-ready',
      )
    ) {
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
      await resend.sendEmail(ctx, {
        from: RESEND_FROM,
        to: user.email,
        subject,
        html,
        text,
      })
      await ctx.db.insert('emailLog', {
        orgId: session.orgId,
        template: 'report-ready',
        recipient: user.email,
        status: 'sent',
        sessionId,
        createdAt: Date.now(),
      })
      sent = true
    }
    return sent
  },
})
