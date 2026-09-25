import { ConvexError, v } from 'convex/values'
import { mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import { RESEND_FROM, resend } from './email'
import { organizationDeletedEmail } from './emailTemplates'
import { roleValidator } from './schema'
import {
  requireAppUser,
  requireOrgMember,
  requireOrgRole,
  safeAppUser,
} from './lib/auth'
import { setLastOrgSlug } from './lib/userPrefs'
import { revokeMemberGrants } from './lib/projectAccess'
import { resolveAvatarUrl, resolveLogoUrl } from './lib/storage'
import { WRITE_URL_TTL_SECONDS } from './lib/objectStore'
import type { DataModel, Id } from './_generated/dataModel'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

export const listMembers = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgMember(ctx, orgId)
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    return await Promise.all(
      members.map(async (m) => {
        const u = await ctx.db.get("users", m.userId)
        return {
          _id: m._id,
          userId: m.userId,
          email: u?.email ?? '',
          name: u?.name ?? null,
          avatarUrl: u ? await resolveAvatarUrl(ctx, u) : null,
          role: m.role,
          joinedAt: m.joinedAt,
        }
      }),
    )
  },
})

const SLUG_RE = /^[a-z0-9-]{3,40}$/
// Same cap as the forms; enforced here because a form is only a suggestion.
const MAX_NAME_LENGTH = 80

// Reserved slugs that would clash with platform routes or have semantic
// ambiguity (`me/admin/...`). Keep this aligned with `src/routes/` top-level
// segments. If a new route is added under `app/$orgSlug/...` that uses a
// previously unreserved word, add it here.
const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'auth', 'login', 'register', 'logout', 'signin',
  'signup', 'sign-in', 'sign-up', 'me', 'settings', 'billing',
  'invitations', 'onboarding', 'reset-password', 'forgot-password',
  'verify-email', 'accept-invite', 'help', 'docs', 'support', 'status',
  'www', 'public', 'static', 'assets', 'health', 'about', 'terms',
  'privacy', 'pricing', 'home',
])

// access: public by design — this is the slug availability probe on the
// signup form, where the caller has no organisation yet. It returns only
// available / invalid / reserved / taken, never any organisation data.
export const checkSlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const normalized = slug.toLowerCase().trim()
    if (!SLUG_RE.test(normalized)) return { available: false, reason: 'invalid' as const }
    if (RESERVED_SLUGS.has(normalized))
      return { available: false, reason: 'reserved' as const }
    const conflict = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', normalized))
      .unique()
    if (conflict) return { available: false, reason: 'taken' as const }
    return { available: true } as const
  },
})

export const create = mutation({
  args: { name: v.string(), slug: v.string() },
  handler: async (ctx, { name, slug }) => {
    const user = await requireAppUser(ctx)
    const normalizedSlug = slug.toLowerCase().trim()
    if (!SLUG_RE.test(normalizedSlug)) throw new ConvexError('invalid_slug')
    if (RESERVED_SLUGS.has(normalizedSlug))
      throw new ConvexError('slug_reserved')
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName.length > MAX_NAME_LENGTH) {
      throw new ConvexError('invalid_name')
    }

    const conflict = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', normalizedSlug))
      .unique()
    if (conflict) throw new ConvexError('slug_taken')

    const orgId = await ctx.db.insert('organizations', {
      slug: normalizedSlug,
      name: trimmedName,
      createdBy: user._id,
      createdAt: Date.now(),
    })
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId: user._id,
      role: 'owner',
      joinedAt: Date.now(),
    })
    await setLastOrgSlug(ctx, user, normalizedSlug)
    return { orgId, slug: normalizedSlug }
  },
})

export const bySlug = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const user = await safeAppUser(ctx)
    if (!user) return null
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()
    if (!org || org.deletingAt !== undefined) return null
    const member = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org_and_user', (q) =>
        q.eq('orgId', org._id).eq('userId', user._id),
      )
      .unique()
    if (!member) return null
    // Never the raw row: `logoStorageId` is a handle to a blob only admins
    // may manage, and the client needs nothing but the resolved URL.
    return {
      _id: org._id,
      slug: org.slug,
      name: org.name,
      logoUrl: await resolveLogoUrl(ctx, org),
    }
  },
})

export const setLastOrg = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const user = await requireAppUser(ctx)
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique()
    if (!org) throw new ConvexError('not_found')
    await requireOrgMember(ctx, org._id)
    await setLastOrgSlug(ctx, user, slug)
    return null
  },
})

export const updateGeneral = mutation({
  args: {
    orgId: v.id('organizations'),
    name: v.string(),
  },
  handler: async (ctx, { orgId, name }) => {
    await requireOrgRole(ctx, orgId, 'admin')
    const trimmedName = name.trim()
    if (!trimmedName || trimmedName.length > MAX_NAME_LENGTH) {
      throw new ConvexError('invalid_name')
    }
    await ctx.db.patch("organizations", orgId, { name: trimmedName })
    return null
  },
})

export async function countOwners(
  ctx: GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>,
  orgId: Id<'organizations'>,
): Promise<number> {
  const members = await ctx.db
    .query('organizationMembers')
    .withIndex('by_org', (q) => q.eq('orgId', orgId))
    .collect()
  return members.filter((m) => m.role === 'owner').length
}

export const updateMemberRole = mutation({
  args: {
    orgId: v.id('organizations'),
    memberId: v.id('organizationMembers'),
    role: roleValidator,
  },
  handler: async (ctx, { orgId, memberId, role }) => {
    const { member: acting } = await requireOrgRole(ctx, orgId, 'admin')
    const target = await ctx.db.get("organizationMembers", memberId)
    if (!target || target.orgId !== orgId) throw new ConvexError('not_found')

    if (target.role === 'owner' || role === 'owner') {
      if (acting.role !== 'owner') throw new ConvexError('owner_only')
    }
    if (target.role === 'owner' && role !== 'owner') {
      const owners = await countOwners(ctx, orgId)
      if (owners <= 1) throw new ConvexError('last_owner')
    }
    if (target.role === role) return null
    await ctx.db.patch("organizationMembers", memberId, { role })
    return null
  },
})

export const removeMember = mutation({
  args: {
    orgId: v.id('organizations'),
    memberId: v.id('organizationMembers'),
  },
  handler: async (ctx, { orgId, memberId }) => {
    const { user, member: acting } = await requireOrgRole(ctx, orgId, 'admin')
    const target = await ctx.db.get("organizationMembers", memberId)
    if (!target || target.orgId !== orgId) throw new ConvexError('not_found')
    if (target.role === 'owner') {
      if (acting.role !== 'owner') throw new ConvexError('owner_only')
      const owners = await countOwners(ctx, orgId)
      if (owners <= 1) throw new ConvexError('last_owner')
    }
    if (target.userId === user._id && acting.role === 'owner') {
      const owners = await countOwners(ctx, orgId)
      if (owners <= 1) throw new ConvexError('last_owner')
    }

    // A place on a role's team was only ever legal because the person was a
    // member (`setTeam` rejects a non-member), so it dies with the membership.
    // Left behind, it silently restores the role if they are ever re-invited.
    // Their report links go with it (h03).
    await revokeMemberGrants(ctx, target.userId, orgId)

    await ctx.db.delete("organizationMembers", memberId)
    return null
  },
})

/** What deleting the organisation takes with it, for the owner's confirmation. */
export const deletionSummary = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgRole(ctx, orgId, 'owner')
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    const invitations = await ctx.db
      .query('invitations')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    return {
      roles: projects.length,
      // The projects' own counters: reading every session to count them would
      // make this card re-run on every candidate's upload.
      candidates: projects.reduce((sum, p) => sum + p.sessionCount, 0),
      members: members.length,
      pendingInvitations: invitations.filter((i) => !i.acceptedAt).length,
    }
  },
})

/**
 * Delete the organisation and everything in it. Owner-only, confirmed by
 * typing its name.
 *
 * This only freezes it: from the moment `deletingAt` is set, every member,
 * candidate link and share link is refused (see `requireOrgMember`,
 * `evaluateSessionGate`, `resolveShare`), and a second request fails on that
 * same guard rather than mailing everyone twice. The erasure itself
 * (convex/orgErasure.ts) starts once every upload URL signed before the
 * freeze has expired, so no object can land in the bucket after the keys
 * that name it have been collected.
 */
export const requestDeletion = mutation({
  args: { orgId: v.id('organizations'), confirmName: v.string() },
  handler: async (ctx, { orgId, confirmName }) => {
    const { user, org } = await requireOrgRole(ctx, orgId, 'owner')
    if (confirmName.trim() !== org.name) {
      throw new ConvexError('confirm_mismatch')
    }
    await ctx.db.patch('organizations', orgId, { deletingAt: Date.now() })

    // Told now, while the memberships still say who to tell.
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .collect()
    for (const m of members) {
      const recipient = await ctx.db.get('users', m.userId)
      if (!recipient) continue
      const { subject, html, text } = organizationDeletedEmail({
        locale: recipient.preferredLanguage ?? 'en',
        orgName: org.name,
        deletedBy: user.name ?? user.email,
      })
      await resend.sendEmail(ctx, {
        from: RESEND_FROM,
        to: recipient.email,
        subject,
        html,
        text,
      })
    }

    await ctx.scheduler.runAfter(
      WRITE_URL_TTL_SECONDS * 1000,
      internal.orgErasure.step,
      { orgId },
    )
    console.log('[org-erasure] requested', {
      orgId,
      members: members.length,
    })
    return null
  },
})
