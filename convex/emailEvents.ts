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
 * Resend's event names → the outcomes worth distinguishing. A `Map`, not an
 * object literal (h07): indexing a literal with `constructor` returns a
 * function, and Resend adds event types over time — an unrecognised one must
 * fall through rather than be mapped to something wrong.
 */
const STATUS_BY_EVENT = new Map<string, DeliveryStatus>([
  ['email.sent', 'sent'],
  ['email.delivered', 'delivered'],
  ['email.delivery_delayed', 'sent'],
  ['email.bounced', 'bounced'],
  ['email.complained', 'complained'],
  ['email.failed', 'failed'],
])

/**
 * How far along an email is. The status only ever moves up (Pipe F9, h07):
 * Svix redelivers for up to a day and in no particular order, so a retried
 * `email.sent` landing after `email.bounced` used to turn a dead address back
 * into a sent invitation — and clear the error the recruiter needed to see.
 * The three failures share the top rank: the first one recorded stands.
 */
const RANK: Record<DeliveryStatus, number> = {
  sent: 0,
  delivered: 1,
  bounced: 2,
  complained: 2,
  failed: 2,
}

export const record = internalMutation({
  args: vOnEmailEventArgs,
  handler: async (ctx, { id, event }) => {
    const status = STATUS_BY_EVENT.get(event.type)
    if (!status) return null

    const entry = await ctx.db
      .query('emailLog')
      .withIndex('by_provider_id', (q) => q.eq('providerId', id))
      .first()
    // No row means the mail was sent by something that does not log here
    // (Better Auth's own transactional mail, for instance). Nothing to update.
    if (!entry) return null
    if (RANK[status] <= RANK[entry.status]) return null

    await ctx.db.patch('emailLog', entry._id, {
      status,
      error: RANK[status] === RANK.failed ? event.type : undefined,
    })
    return null
  },
})

/** Recent delivery outcomes for an organisation, newest first. */
export const recent = query({
  args: { orgId: v.id('organizations'), limit: v.optional(v.number()) },
  handler: async (ctx, { orgId, limit }) => {
    const { member } = await requireOrgMember(ctx, orgId)
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
            (await canSeeProject(ctx, project, member))
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
