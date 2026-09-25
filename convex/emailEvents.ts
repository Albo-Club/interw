/**
 * Deliverability.
 *
 * An invitation that bounced is not a candidate who ignored you — it is a
 * typo, a dead mailbox, or a spam filter, and the recruiter needs to know
 * which. Resend posts delivery events to the component's webhook; this turns
 * them into a status on the row we wrote when we sent the mail.
 */

import { v } from 'convex/values'
import { vOnEmailEventArgs } from '@convex-dev/resend'

import { internalMutation, query } from './_generated/server'
import { requireOrgMember } from './lib/auth'
import { canSeeProject } from './lib/projectAccess'
import type { Doc, Id } from './_generated/dataModel'

type DeliveryStatus = Doc<'emailLog'>['status']

/**
 * Resend's event names → the outcomes worth distinguishing. A Map, not an
 * object literal: Resend adds event types over time, and an unrecognised one
 * must fall through rather than be mapped to something wrong — including one
 * named like an `Object.prototype` member.
 */
const STATUS_BY_EVENT = new Map<string, DeliveryStatus>([
  ['email.sent', 'sent'],
  ['email.delivered', 'delivered'],
  ['email.delivery_delayed', 'sent'],
  ['email.bounced', 'bounced'],
  ['email.complained', 'complained'],
  ['email.failed', 'failed'],
])

export function statusForEvent(type: string): DeliveryStatus | undefined {
  return STATUS_BY_EVENT.get(type)
}

/**
 * How far along a mail is. A status only moves forward: Svix retries a failed
 * delivery for up to a day, so a `sent` can arrive after the bounce it
 * preceded, and must not erase it. The outcomes share the top rank, so a
 * complaint still lands on a delivered mail.
 */
const PROGRESS: Record<DeliveryStatus, number> = {
  sent: 0,
  delivered: 1,
  bounced: 2,
  complained: 2,
  failed: 2,
}

export const record = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    const status = statusForEvent(event.type)
    if (!status) return null

    const entry = await ctx.db
      .query('emailLog')
      .withIndex('by_provider_id', (q) => q.eq('providerId', id))
      .first()
    // No row means the mail was sent by something that does not log here
    // (Better Auth's own transactional mail, for instance). Nothing to update.
    if (!entry) return null
    if (PROGRESS[status] < PROGRESS[entry.status]) return null

    await ctx.db.patch('emailLog', entry._id, {
      status,
      error:
        status === 'bounced' || status === 'failed' || status === 'complained'
          ? event.type
          : undefined,
    })
    return null
  },
})

/** Recent delivery outcomes for an organisation, newest first. */
export const recent = query({
  args: { orgId: v.id('organizations'), limit: v.optional(v.number()) },
  handler: async (ctx, { orgId, limit }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    const rows = await ctx.db
      .query('emailLog')
      .withIndex('by_org_and_created', (q) => q.eq('orgId', orgId))
      .order('desc')
      .take(Math.min(limit ?? 50, 200))

    // A row that names a candidate inherits the visibility of that candidate's
    // role: a confidential search must not leak through the deliverability
    // list any more than through the search box.
    const visibleByProject = new Map<Id<'projects'>, boolean>()
    const visible: typeof rows = []
    for (const row of rows) {
      // Team invites are admin data (`invitations.listForOrg` is admin-only).
      if (row.invitationId && member.role === 'member') continue
      if (row.sessionId) {
        const session = await ctx.db.get('sessions', row.sessionId)
        if (!session) continue
        let ok = visibleByProject.get(session.projectId)
        if (ok === undefined) {
          const project = await ctx.db.get('projects', session.projectId)
          ok =
            project !== null &&
            (await canSeeProject(ctx, project, user._id, member.role))
          visibleByProject.set(session.projectId, ok)
        }
        if (!ok) continue
      }
      visible.push(row)
    }
    return visible.map((row) => ({
      _id: row._id,
      template: row.template,
      recipient: row.recipient,
      status: row.status,
      error: row.error ?? null,
      sessionId: row.sessionId ?? null,
      createdAt: row.createdAt,
    }))
  },
})
