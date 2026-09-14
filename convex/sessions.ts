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

import { mutation, query } from './_generated/server'
import { requireOrgMember } from './lib/auth'
import { requireProjectAccess } from './lib/projectAccess'
import { evaluateSessionGate } from './lib/sessionState'
import { generateToken } from './lib/tokens'
import { consumeLimit } from './rateLimiters'
import { RESEND_FROM, resend } from './email'
import { candidateInvitationEmail } from './emailTemplates'
import type { Doc, Id } from './_generated/dataModel'

const NAME_MAX = 120
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MAX_BULK_INVITES = 100

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

    const existing = await ctx.db
      .query('sessions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    const byEmail = new Map(
      existing
        .filter((s) => s.status === 'pending' || s.status === 'in_progress')
        .map((s) => [s.candidateEmail, s]),
    )

    const now = Date.now()
    const results: Array<{ sessionId: Id<'sessions'>; created: boolean }> = []
    let created = 0

    for (const raw of candidates) {
      const candidate = normalizeCandidate(raw)
      const already = byEmail.get(candidate.email)
      if (already) {
        results.push({ sessionId: already._id, created: false })
        await sendInvitation(ctx, {
          session: already,
          project,
          orgName: org.name,
        })
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
      })
      created += 1
      results.push({ sessionId, created: true })

      const session = await ctx.db.get('sessions', sessionId)
      if (session) {
        await sendInvitation(ctx, { session, project, orgName: org.name })
      }
    }

    if (created > 0) {
      await ctx.db.patch('projects', projectId, {
        sessionCount: project.sessionCount + created,
      })
    }
    return { results, created }
  },
})

async function sendInvitation(
  ctx: Parameters<typeof resend.sendEmail>[0],
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
  await resend.sendEmail(ctx, {
    from: RESEND_FROM,
    to: session.candidateEmail,
    subject,
    html,
    text,
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
