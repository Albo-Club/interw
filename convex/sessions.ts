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
import { requireOrgMember } from './lib/auth'
import { requireProjectAccess } from './lib/projectAccess'
import { evaluateSessionGate } from './lib/sessionState'
import { generateToken } from './lib/tokens'
import { deleteObjects } from './lib/objectStore'
import { hashEmail } from './purge'
import { consumeLimit } from './rateLimiters'
import { RESEND_FROM, resend } from './email'
import { candidateInvitationEmail } from './emailTemplates'
import type { GenericMutationCtx } from 'convex/server'
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
function toRecruiterRow(session: Doc<'sessions'>) {
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
    recruiterDecision: session.recruiterDecision ?? null,
    lastQuestionIndex: session.lastQuestionIndex,
  }
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
    return { ...page, page: page.page.map(toRecruiterRow) }
  },
})

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
    await requireProjectAccess(ctx, session.projectId)
    return { url: invitationUrl(session.accessToken) }
  },
})

export const resendInvitation = mutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { project, user } = await requireProjectAccess(ctx, session.projectId)
    if (session.status === 'completed' || session.status === 'cancelled') {
      throw new ConvexError('session_closed')
    }
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
    await requireProjectAccess(ctx, session.projectId)
    if (session.status === 'completed') throw new ConvexError('session_closed')
    await ctx.db.patch('sessions', sessionId, { status: 'cancelled' })
    return null
  },
})

/** Whether a given session's link would work right now, for the recruiter. */
export const linkStatus = query({
  args: { sessionId: v.id('sessions'), now: v.number() },
  handler: async (ctx, { sessionId, now }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    const { project } = await requireProjectAccess(ctx, session.projectId)
    return evaluateSessionGate({ session, project, now })
  },
})

export const countsForOrg = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgMember(ctx, orgId)
    const recent = await ctx.db
      .query('sessions')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .order('desc')
      .take(500)
    return {
      total: recent.length,
      completed: recent.filter((s) => s.status === 'completed').length,
      inProgress: recent.filter((s) => s.status === 'in_progress').length,
      pending: recent.filter((s) => s.status === 'pending').length,
    }
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
 * Delete everything about one candidate, at the recruiter's request.
 *
 * Same machinery as the candidate's own erasure — one implementation, so the
 * two cannot drift into deleting different things.
 */
export const deleteCandidateData = action({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }): Promise<{ deleted: true }> => {
    await ctx.runQuery(internal.sessions.assertCanDelete, { sessionId })
    const objects = await ctx.runQuery(internal.purge.collectSessionObjects, {
      sessionId,
    })
    if (!objects) return { deleted: true }
    await deleteObjects(objects.keys)
    await ctx.runMutation(internal.purge.deleteSessionRecords, {
      sessionId,
      reason: 'recruiter_delete',
      candidateEmailHash: await hashEmail(objects.candidateEmail),
      objectsDeleted: objects.keys.length,
    })
    return { deleted: true }
  },
})

export const assertCanDelete = internalQuery({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) throw new ConvexError('not_found')
    await requireProjectAccess(ctx, session.projectId)
    return null
  },
})
