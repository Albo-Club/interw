import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { components } from './_generated/api'
import { invitationRoleValidator } from './schema'
import { authComponent } from './auth'
import { provisionAppUser, requireAppUser, requireOrgRole } from './lib/auth'
import { emailsMatch, normalizeEmail } from './lib/invitations'
import { setLastOrgSlug } from './lib/userPrefs'
import { RESEND_FROM, resend } from './email'
import { invitationEmail } from './emailTemplates'
import { consumeLimit } from './rateLimiters'
import type { MutationCtx, QueryCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'
import type { FunctionReference } from 'convex/server'

const TOKEN_BYTES = 32
const EXPIRES_MS = 1000 * 60 * 60 * 24 * 7 // 7 days
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function genToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

function acceptUrl(token: string): string {
  return `${process.env.SITE_URL!}/accept-invite/${token}`
}

async function inviterName(
  ctx: QueryCtx,
  inv: Doc<'invitations'>,
): Promise<string | null> {
  const inviter = await ctx.db.get('users', inv.invitedBy)
  return inviter ? (inviter.name ?? inviter.email) : null
}

async function isMemberByEmail(
  ctx: QueryCtx,
  orgId: Id<'organizations'>,
  email: string,
): Promise<boolean> {
  const users = await ctx.db
    .query('users')
    .withIndex('by_email', (q) => q.eq('email', email))
    .take(10)
  for (const u of users) {
    const member = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_and_user', (q) =>
        q.eq('orgId', orgId).eq('userId', u._id),
      )
      .unique()
    if (member) return true
  }
  return false
}

/**
 * Better Auth only opens a session on a verified address today (password
 * sign-up requires verification; magic link and Google verify by construction).
 * Accepting WITHOUT a token rests on that address alone, so it is checked here
 * rather than inherited from a configuration that may change.
 */
async function hasVerifiedEmail(ctx: QueryCtx): Promise<boolean> {
  const baUser = await authComponent.safeGetAuthUser(ctx)
  return baUser?.emailVerified === true
}

/** Delete an invitation with its send log: the sends name the invitee. */
async function deleteInvitation(
  ctx: MutationCtx,
  invitationId: Id<'invitations'>,
) {
  const sends = await ctx.db
    .query('emailLog')
    .withIndex('by_invitation', (q) => q.eq('invitationId', invitationId))
    .collect()
  for (const send of sends) await ctx.db.delete('emailLog', send._id)
  await ctx.db.delete('invitations', invitationId)
}

/**
 * Send the invitation email and log it with the provider id. The log row is
 * what Resend's delivery webhook (`emailEvents.record`) updates, so a bounce
 * shows up on the pending invitation instead of vanishing.
 */
async function sendInvitation(
  ctx: MutationCtx,
  inv: Doc<'invitations'>,
  inviter: Doc<'users'>,
): Promise<void> {
  const org = await ctx.db.get('organizations', inv.orgId)
  if (!org) throw new ConvexError('not_found')
  // Prefer the recipient's stored language; fall back to the inviter's so
  // the invite at least matches the sender's locale, then English.
  const recipient = await ctx.db
    .query('users')
    .withIndex('by_email', (q) => q.eq('email', inv.email))
    .first()
  const locale =
    recipient?.preferredLanguage ?? inviter.preferredLanguage ?? 'en'
  const { subject, html, text } = invitationEmail({
    locale,
    inviterName: inviter.name ?? inviter.email,
    orgName: org.name,
    role: inv.role,
    expiresAt: inv.expiresAt,
    acceptUrl: acceptUrl(inv.token),
  })
  const providerId = await resend.sendEmail(ctx, {
    from: RESEND_FROM,
    to: inv.email,
    subject,
    html,
    text,
    replyTo: [inviter.email],
  })
  await ctx.db.insert('emailLog', {
    orgId: inv.orgId,
    template: 'team-invitation',
    recipient: inv.email,
    status: 'sent',
    providerId,
    invitationId: inv._id,
    createdAt: Date.now(),
  })
}

export const create = mutation({
  args: {
    orgId: v.id('organizations'),
    email: v.string(),
    role: invitationRoleValidator,
  },
  handler: async (ctx, { orgId, email, role }) => {
    const { user: inviter } = await requireOrgRole(ctx, orgId, 'admin')
    await consumeLimit(ctx, 'invitationCreate', inviter._id)

    const normalizedEmail = normalizeEmail(email)
    if (!EMAIL_RE.test(normalizedEmail)) {
      throw new ConvexError('invalid_email')
    }
    if (await isMemberByEmail(ctx, orgId, normalizedEmail)) {
      throw new ConvexError('already_member')
    }

    const existing = await ctx.db
      .query('invitations')
      .withIndex('by_email_and_org', (q) =>
        q.eq('email', normalizedEmail).eq('orgId', orgId),
      )
      // eslint-disable-next-line @convex-dev/no-filter-in-query -- post-index narrow on a max-1-row scan
      .filter((q) => q.eq(q.field('acceptedAt'), undefined))
      .first()
    if (existing) {
      if (existing.expiresAt >= Date.now()) {
        throw new ConvexError('already_invited')
      }
      // An expired invitation is history, not a pending one: it must not
      // block inviting the same person again.
      await deleteInvitation(ctx, existing._id)
    }

    const invId = await ctx.db.insert('invitations', {
      orgId,
      email: normalizedEmail,
      role,
      token: genToken(),
      invitedBy: inviter._id,
      expiresAt: Date.now() + EXPIRES_MS,
    })
    const inv = await ctx.db.get('invitations', invId)
    if (!inv) throw new ConvexError('not_found')
    await sendInvitation(ctx, inv, inviter)
    return invId
  },
})

/**
 * Send the email again and give the invitation a fresh week. The token is
 * kept, so a link already copied by hand keeps working. The admin who resends
 * becomes the inviter, since the email now goes out under their name.
 */
export const resendInvitation = mutation({
  args: { invitationId: v.id('invitations') },
  handler: async (ctx, { invitationId }) => {
    const inv = await ctx.db.get('invitations', invitationId)
    if (!inv) throw new ConvexError('not_found')
    const { user } = await requireOrgRole(ctx, inv.orgId, 'admin')
    if (inv.acceptedAt) throw new ConvexError('already_accepted')
    await consumeLimit(ctx, 'invitationCreate', user._id)

    const patch = { expiresAt: Date.now() + EXPIRES_MS, invitedBy: user._id }
    await ctx.db.patch('invitations', inv._id, patch)
    await sendInvitation(ctx, { ...inv, ...patch }, user)
    return null
  },
})

/**
 * The accept link, for an admin who wants to send it themselves. A separate
 * call on purpose, like `sessions.invitationLink`: the token never travels in
 * the list payload.
 */
export const link = query({
  args: { invitationId: v.id('invitations') },
  handler: async (ctx, { invitationId }) => {
    const inv = await ctx.db.get('invitations', invitationId)
    if (!inv) throw new ConvexError('not_found')
    await requireOrgRole(ctx, inv.orgId, 'admin')
    return { url: acceptUrl(inv.token) }
  },
})

/**
 * Public preview of an invitation by token. The token itself authenticates
 * access — no auth required. Returns minimal info so the accept page can
 * branch its UI between sign-in / sign-up / switch-account, and name the
 * organisation and inviter on every outcome, including the dead ends.
 */
// access: public by design — an invitee has no account yet and the invitation
// token is the credential. Returns only the org name, the inviter's name, the
// role and the invited address.
export const preview = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const inv = await ctx.db
      .query('invitations')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique()
    if (!inv) return { kind: 'not_found' as const }
    const org = await ctx.db.get('organizations', inv.orgId)
    if (!org) return { kind: 'not_found' as const }

    const context = {
      orgName: org.name,
      inviterName: await inviterName(ctx, inv),
    }
    if (inv.acceptedAt) return { kind: 'already_accepted' as const, ...context }
    if (inv.expiresAt < Date.now()) {
      return { kind: 'expired' as const, ...context }
    }

    const adapter = (
      components as unknown as {
        betterAuth: {
          adapter: {
            findMany: FunctionReference<'query', 'internal'>
          }
        }
      }
    ).betterAuth.adapter
    const result = (await ctx.runQuery(adapter.findMany, {
      model: 'user',
      paginationOpts: { numItems: 1, cursor: null },
      where: [{ field: 'email', operator: 'eq', value: inv.email }],
    })) as { page: Array<{ email?: string }> }
    const accountExists = result.page.length > 0

    return {
      kind: 'ok' as const,
      email: inv.email,
      role: inv.role,
      accountExists,
      ...context,
    }
  },
})

/**
 * Shared by both ways of accepting. `joined` tells a first acceptance from an
 * existing member re-opening the link, so the page only welcomes the former.
 */
async function acceptInvitation(
  ctx: MutationCtx,
  user: Doc<'users'>,
  inv: Doc<'invitations'>,
) {
  const org = await ctx.db.get('organizations', inv.orgId)
  if (!org) throw new ConvexError('not_found')

  const alreadyMember = await ctx.db
    .query('organizationMembers')
    .withIndex('by_org_and_user', (q) =>
      q.eq('orgId', inv.orgId).eq('userId', user._id),
    )
    .unique()

  // Idempotent / replayable: an existing member is always a no-op success,
  // whatever the invite's acceptedAt state. The accept effect can fire twice
  // (re-render, second tab) or the user can re-open the link — none of those
  // should surface an error. Reconcile acceptedAt if it never got stamped so
  // the invite stops showing as pending.
  if (alreadyMember) {
    if (!inv.acceptedAt) {
      await ctx.db.patch('invitations', inv._id, { acceptedAt: Date.now() })
    }
    await setLastOrgSlug(ctx, user, org.slug)
    return {
      orgSlug: org.slug,
      orgName: org.name,
      role: alreadyMember.role,
      joined: false,
    }
  }

  // Not a member yet → a genuine first acceptance. Enforce the lifecycle
  // guards. Email match is case- and whitespace-insensitive on both sides.
  if (inv.acceptedAt) throw new ConvexError('already_accepted')
  if (inv.expiresAt < Date.now()) throw new ConvexError('expired')
  if (!emailsMatch(inv.email, user.email)) {
    throw new ConvexError('email_mismatch')
  }

  await ctx.db.insert('organizationMembers', {
    orgId: inv.orgId,
    userId: user._id,
    role: inv.role,
    joinedAt: Date.now(),
  })
  await ctx.db.patch('invitations', inv._id, { acceptedAt: Date.now() })

  await setLastOrgSlug(ctx, user, org.slug)
  return { orgSlug: org.slug, orgName: org.name, role: inv.role, joined: true }
}

// access: public by design — accepting an invitation is how an account first
// joins an organisation; the token is the credential and is consumed here.
export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await provisionAppUser(ctx)
    const inv = await ctx.db
      .query('invitations')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique()
    if (!inv) throw new ConvexError('not_found')
    return await acceptInvitation(ctx, user, inv)
  },
})

/**
 * Accept from inside the app, for someone who signed up without clicking the
 * link. There is no token here: the caller's verified address is the
 * credential, and an invitation addressed to anyone else fails exactly like
 * one that does not exist.
 */
export const acceptById = mutation({
  args: { invitationId: v.id('invitations') },
  handler: async (ctx, { invitationId }) => {
    const user = await provisionAppUser(ctx)
    const inv = await ctx.db.get('invitations', invitationId)
    if (
      !inv ||
      !emailsMatch(inv.email, user.email) ||
      !(await hasVerifiedEmail(ctx))
    ) {
      throw new ConvexError('not_found')
    }
    return await acceptInvitation(ctx, user, inv)
  },
})

/**
 * Invitations waiting for the signed-in user's own address, so someone who
 * signed up without the link is offered the organisation instead of creating
 * a duplicate one. Never the token: accepting goes through `acceptById`.
 * Expired rows are left for the client to hide, since a query cannot watch
 * the clock.
 */
export const listMine = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx)
    if (!(await hasVerifiedEmail(ctx))) return []
    const invs = await ctx.db
      .query('invitations')
      .withIndex('by_email_and_org', (q) =>
        q.eq('email', normalizeEmail(user.email)),
      )
      .take(50)
    const mine = []
    for (const inv of invs) {
      if (inv.acceptedAt) continue
      const member = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', inv.orgId).eq('userId', user._id),
        )
        .unique()
      if (member) continue
      const org = await ctx.db.get('organizations', inv.orgId)
      if (!org) continue
      mine.push({
        _id: inv._id,
        orgName: org.name,
        inviterName: await inviterName(ctx, inv),
        role: inv.role,
        expiresAt: inv.expiresAt,
      })
    }
    return mine
  },
})

export const revoke = mutation({
  args: { invitationId: v.id('invitations') },
  handler: async (ctx, { invitationId }) => {
    const inv = await ctx.db.get("invitations", invitationId)
    if (!inv) throw new ConvexError('not_found')
    await requireOrgRole(ctx, inv.orgId, 'admin')
    if (inv.acceptedAt) throw new ConvexError('already_accepted')
    await deleteInvitation(ctx, invitationId)
    return null
  },
})

/**
 * Open invitations for the settings page. Expired ones stay listed — the
 * client labels them — so an admin can see who never joined and resend.
 * `deliveryStatus` is the latest send's outcome as reported by Resend.
 */
export const listForOrg = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgRole(ctx, orgId, 'admin')
    const invs = await ctx.db
      .query('invitations')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    return await Promise.all(
      invs
        .filter((i) => !i.acceptedAt)
        .map(async (i) => {
          const lastSend = await ctx.db
            .query('emailLog')
            .withIndex('by_invitation', (q) => q.eq('invitationId', i._id))
            .order('desc')
            .first()
          return {
            _id: i._id,
            email: i.email,
            role: i.role,
            expiresAt: i.expiresAt,
            invitedByName: await inviterName(ctx, i),
            sentAt: lastSend?.createdAt ?? i._creationTime,
            deliveryStatus: lastSend?.status ?? null,
          }
        }),
    )
  },
})
