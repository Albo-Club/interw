/**
 * Candidate sessions, recruiter side.
 *
 * A session only ever exists because a recruiter created it. With no public
 * role page in scope, no anonymous caller writes to this table without a
 * pre-existing token — which removes an entire class of abuse before it can
 * be written.
 */

import { ConvexError, v } from 'convex/values'
import { paginationOptsValidator } from 'convex/server'

import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  requireProjectAccess,
  requireProjectOwnerOrAdmin,
} from './lib/projectAccess'
import { isPastDeadline } from './lib/sessionState'
import { generateToken } from './lib/tokens'
import { eraseSession } from './purge'
import { consumeLimit } from './rateLimiters'
import { RESEND_FROM, resend } from './email'
import { candidateInvitationEmail } from './emailTemplates'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

const NAME_MAX = 120
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MAX_BULK_INVITES = 100
/** Emails per scheduled batch, so one batch stays well inside a transaction. */
const NOTIFY_BATCH = 20

/**
 * Retention clock for an application that has not gone anywhere: six months
 * from the invitation.
 *
 * Deliberately shorter than the twelve months an interview gets once it is
 * finished (`RETENTION_MS` in convex/interview.ts, set by `finish`, which
 * overwrites this). Most invitations in a hiring funnel are never opened or
 * are abandoned part-way, and those are the records hardest to justify
 * keeping: a name, an address, a CV and two half-answers, for a process that
 * produced no assessment. Without a clock here they were kept forever.
 */
const INVITED_RETENTION_MS = 183 * 24 * 60 * 60 * 1000

/**
 * What a recruiter list shows. `accessToken` is absent by construction: the
 * link is built server-side, on request, for one session at a time.
 */
function toRecruiterRow(
  session: Doc<'sessions'>,
  deliveryIssue: DeliveryIssue | null,
) {
  return {
    _id: session._id,
    projectId: session.projectId,
    candidateName: session.candidateName,
    candidateEmail: session.candidateEmail,
    status: session.status,
    invitedAt: session.invitedAt,
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null,
    lastActivityAt: session.lastActivityAt ?? null,
    durationSeconds: session.durationSeconds ?? null,
    // Denormalised by the queue when the report lands (see schema): reading
    // `reports` per row here would make the table a reactive N+1.
    overallScore: session.overallScore ?? null,
    recommendation: session.recommendation ?? null,
    recruiterDecision: session.recruiterDecision ?? null,
    lastQuestionIndex: session.lastQuestionIndex,
    deliveryIssue,
  }
}

type DeliveryIssue = Exclude<Doc<'emailLog'>['status'], 'sent' | 'delivered'>

/**
 * Whether the latest invitation sent to this candidate failed to reach them.
 *
 * Read per row, off the session's own latest invitation, and not off the
 * organisation's last 200 emails: one bulk campaign used to push an older
 * bounce out of that window, and the recruiter never saw it. A re-send that
 * got through clears an earlier failure. Keyed on the template too, so the
 * report-ready mail and its delivery webhooks do not re-run the list.
 */
async function inviteDeliveryIssue(
  ctx: GenericQueryCtx<DataModel>,
  sessionId: Id<'sessions'>,
): Promise<DeliveryIssue | null> {
  const latest = await ctx.db
    .query('emailLog')
    .withIndex('by_session_and_template', (q) =>
      q.eq('sessionId', sessionId).eq('template', 'candidate-invitation'),
    )
    .order('desc')
    .first()
  if (!latest || latest.status === 'sent' || latest.status === 'delivered') {
    return null
  }
  return latest.status
}

export const listByProject = query({
  args: {
    projectId: v.id('projects'),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, { projectId, paginationOpts }) => {
    await requireProjectAccess(ctx, projectId)
    const page = await ctx.db
      .query('sessions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .order('desc')
      .paginate(paginationOpts)
    return {
      ...page,
      page: await Promise.all(
        page.page.map(async (session) =>
          toRecruiterRow(session, await inviteDeliveryIssue(ctx, session._id)),
        ),
      ),
    }
  },
})

/**
 * A role past its deadline takes no new invitation and no reminder: the
 * candidate would open a link that already reads "This interview has closed".
 * The 24 h grace in `expireOverdueSessions` is for interviews already under
 * way, not for sending new ones.
 */
function assertBeforeDeadline(project: Doc<'projects'>) {
  if (isPastDeadline(project, Date.now())) {
    throw new ConvexError('project_expired')
  }
}

function normalizeCandidate(input: { name: string; email: string }) {
  const name = input.name.trim()
  const email = input.email.trim().toLowerCase()
  if (!name || name.length > NAME_MAX) throw new ConvexError('invalid_name')
  if (!EMAIL_RE.test(email)) throw new ConvexError('invalid_email')
  return { name, email }
}

function invitationUrl(token: string): string {
  const siteUrl = process.env.SITE_URL
  if (!siteUrl) throw new ConvexError('site_url_not_configured')
  return `${siteUrl.replace(/\/+$/, '')}/s/${token}`
}

/**
 * Invite one or many candidates in a single transaction.
 *
 * Re-inviting an address that already has an open session returns the
 * existing session rather than creating a second one: a recruiter pasting a
 * list twice should not produce two links to the same person, each with half
 * the answers.
 */
export const invite = mutation({
  args: {
    projectId: v.id('projects'),
    candidates: v.array(v.object({ name: v.string(), email: v.string() })),
  },
  handler: async (ctx, { projectId, candidates }) => {
    const { project, user } = await requireProjectAccess(ctx, projectId)
    if (project.status !== 'active') throw new ConvexError('project_not_active')
    assertBeforeDeadline(project)
    if (candidates.length === 0) throw new ConvexError('no_candidates')
    if (candidates.length > MAX_BULK_INVITES) {
      throw new ConvexError('too_many_candidates')
    }
    await consumeLimit(ctx, 'candidateInvite', user._id)

    const org = await ctx.db.get('organizations', project.orgId)
    if (!org) throw new ConvexError('not_found')

    const now = Date.now()
    const results: Array<{ sessionId: Id<'sessions'>; created: boolean }> = []
    const toNotify: Array<Id<'sessions'>> = []
    let created = 0

    for (const raw of candidates) {
      const candidate = normalizeCandidate(raw)
      // One indexed lookup per candidate — at most MAX_BULK_INVITES of them —
      // rather than reading every session of the role. `sessions` is the
      // table the schema says genuinely reaches the thousands, and an
      // unbounded `.collect()` on it meant that past a few thousand
      // candidates no further invitation on that role was possible at all,
      // single invitations included: they go through this same path.
      const already = (
        await ctx.db
          .query('sessions')
          .withIndex('by_project_and_email', (q) =>
            q.eq('projectId', projectId).eq('candidateEmail', candidate.email),
          )
          .collect()
      ).find((s) => s.status === 'pending' || s.status === 'in_progress')
      if (already) {
        results.push({ sessionId: already._id, created: false })
        toNotify.push(already._id)
        continue
      }

      const token = generateToken()
      const sessionId = await ctx.db.insert('sessions', {
        orgId: project.orgId,
        projectId,
        accessToken: token,
        candidateName: candidate.name,
        candidateEmail: candidate.email,
        status: 'pending',
        lastQuestionIndex: 0,
        invitedBy: user._id,
        invitedAt: now,
        purgeAfter: now + INVITED_RETENTION_MS,
      })
      created += 1
      results.push({ sessionId, created: true })
      toNotify.push(sessionId)
    }

    if (created > 0) {
      await ctx.db.patch('projects', projectId, {
        sessionCount: project.sessionCount + created,
      })
    }

    // The sessions are committed here; the emails go out afterwards, in
    // batches, from the scheduler. Sending a hundred of them inside this
    // transaction would put the whole invitation campaign at the mercy of one
    // provider hiccup — and roll back a hundred perfectly good sessions with
    // it. Scheduled work is retried on its own.
    for (let i = 0; i < toNotify.length; i += NOTIFY_BATCH) {
      await ctx.scheduler.runAfter(0, internal.sessions.sendInvitationBatch, {
        sessionIds: toNotify.slice(i, i + NOTIFY_BATCH),
      })
    }
    return { results, created }
  },
})

async function sendInvitation(
  ctx: GenericMutationCtx<DataModel>,
  {
    session,
    project,
    orgName,
  }: { session: Doc<'sessions'>; project: Doc<'projects'>; orgName: string },
): Promise<void> {
  const { subject, html, text } = candidateInvitationEmail({
    locale: project.language,
    candidateName: session.candidateName,
    jobTitle: project.jobTitle ?? project.title,
    orgName,
    startUrl: invitationUrl(session.accessToken),
    durationMinutes: project.maxDurationMinutes,
  })
  const providerId = await resend.sendEmail(ctx, {
    from: RESEND_FROM,
    to: session.candidateEmail,
    subject,
    html,
    text,
  })
  // Logged with the provider id so a bounce can be told apart from a
  // candidate who simply has not opened it yet.
  await ctx.db.insert('emailLog', {
    orgId: session.orgId,
    template: 'candidate-invitation',
    recipient: session.candidateEmail,
    status: 'sent',
    providerId,
    sessionId: session._id,
    createdAt: Date.now(),
  })
}

/**
 * The candidate's link, for a recruiter who wants to send it themselves.
 *
 * A separate call on purpose: the token never travels in a list payload, so
 * a screenshot of the candidate table cannot hand someone an interview.
 */
export const invitationLink = query({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    // Owner, admin or the role's creator: the link is the candidate's
    // interview, and whoever holds it can sit it in their name.
    await requireProjectOwnerOrAdmin(ctx, session.projectId)
    return { url: invitationUrl(session.accessToken) }
  },
})

export const resendInvitation = mutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { project, user } = await requireProjectAccess(ctx, session.projectId)
    if (session.status !== 'pending' && session.status !== 'in_progress') {
      throw new ConvexError('session_closed')
    }
    assertBeforeDeadline(project)
    // Pipe F9: an address that hard-bounced (or reported us as spam) does not
    // get the same mail again. Every retry costs the sending domain
    // reputation, and the fix is a corrected address — a new invitation.
    const sent = await ctx.db
      .query('emailLog')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .collect()
    const undeliverable = sent.some(
      (entry) =>
        entry.recipient === session.candidateEmail &&
        (entry.status === 'bounced' || entry.status === 'complained'),
    )
    if (undeliverable) throw new ConvexError('address_undeliverable')
    await consumeLimit(ctx, 'candidateInvite', user._id)
    const org = await ctx.db.get('organizations', session.orgId)
    if (!org) throw new ConvexError('not_found')
    await sendInvitation(ctx, { session, project, orgName: org.name })
    return null
  },
})

/** Close a link without deleting anything the candidate already recorded. */
export const cancel = mutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    // Owner or admin, not any member who can see the role: this destroys a
    // candidate's recordings, their CV and their assessment, irreversibly.
    // It used to be less protected than deleting an empty role.
    await requireProjectOwnerOrAdmin(ctx, session.projectId)
    if (session.status === 'completed') throw new ConvexError('session_closed')
    await ctx.db.patch('sessions', sessionId, { status: 'cancelled' })
    return null
  },
})

/**
 * Send the invitations for a batch of sessions.
 *
 * Internal and scheduled: it runs after the sessions are committed, so a
 * provider failure costs an email that can be re-sent, never the session
 * itself. Each send is independent — one bad address does not stop the batch.
 */
export const sendInvitationBatch = internalMutation({
  args: { sessionIds: v.array(v.id('sessions')) },
  handler: async (ctx, { sessionIds }) => {
    for (const sessionId of sessionIds) {
      const session = await ctx.db.get('sessions', sessionId)
      if (!session) continue
      const project = await ctx.db.get('projects', session.projectId)
      const org = await ctx.db.get('organizations', session.orgId)
      if (!project || !org) continue
      await sendInvitation(ctx, { session, project, orgName: org.name })
    }
    return null
  },
})

/**
 * How long after a role's deadline its open sessions are closed for good.
 *
 * Not zero: `interview.finish` lets a candidate who recorded their answers
 * finish after the deadline, and a recruiter who notices a deadline passed by
 * mistake can still push it back and lose nobody.
 */
const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000
/** Roles read per pass, and session writes per pass. */
const EXPIRY_PROJECTS_PER_PASS = 25
const EXPIRY_WRITES_PER_PASS = 200

/**
 * Close the sessions of a role whose deadline has passed (B6).
 *
 * `expired` was in the schema and written by nobody: an invitation nobody
 * opened stayed `pending` forever, and the table and the dashboard counted it
 * as still in flight. Only the role's deadline is a window — a role without
 * one keeps its links open, and the retention clock set at invitation bounds
 * what is kept.
 *
 * Bounded per pass, and it reschedules itself until the range is drained, so
 * a backlog clears on its own without one transaction carrying all of it.
 */
export const expireOverdueSessions = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  handler: async (ctx, { cursor }) => {
    const cutoff = Date.now() - EXPIRY_GRACE_MS
    const page = await ctx.db
      .query('projects')
      .withIndex('by_expires_at', (q) =>
        q.gte('expiresAt', 0).lt('expiresAt', cutoff),
      )
      .paginate({ numItems: EXPIRY_PROJECTS_PER_PASS, cursor })

    let budget = EXPIRY_WRITES_PER_PASS
    for (const project of page.page) {
      for (const status of ['pending', 'in_progress'] as const) {
        const open = await ctx.db
          .query('sessions')
          .withIndex('by_project_and_status', (q) =>
            q.eq('projectId', project._id).eq('status', status),
          )
          .take(budget)
        for (const session of open) {
          await ctx.db.patch('sessions', session._id, { status: 'expired' })
        }
        budget -= open.length
        if (budget === 0) {
          // Same page again: this role may have more open sessions.
          await ctx.scheduler.runAfter(
            0,
            internal.sessions.expireOverdueSessions,
            { cursor },
          )
          return null
        }
      }
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.sessions.expireOverdueSessions, {
        cursor: page.continueCursor,
      })
    }
    return null
  },
})

/**
 * Delete everything about one candidate, at the recruiter's request.
 *
 * Same machinery as the candidate's own erasure — one implementation, so the
 * two cannot drift into deleting different things.
 */
export const deleteCandidateData = action({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }): Promise<{ deleted: true }> => {
    await ctx.runQuery(internal.sessions.assertCanDelete, { sessionId })
    await eraseSession(ctx, sessionId, 'recruiter_delete')
    return { deleted: true }
  },
})

export const assertCanDelete = internalQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    // Owner or admin, not any member who can see the role: this destroys a
    // candidate's recordings, their CV and their assessment, irreversibly.
    // It used to be less protected than deleting an empty role.
    await requireProjectOwnerOrAdmin(ctx, session.projectId)
    return null
  },
})
