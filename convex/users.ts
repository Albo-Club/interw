import { ConvexError, v } from 'convex/values'

import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { authComponent, createAuth } from './auth'
import { countOwners } from './organizations'
import { provisionAppUser, requireAppUser, safeAppUser } from './lib/auth'
import { setPasswordWithFreshSession } from './lib/accountLifecycle'
import { getLastOrgSlug, setEmailChange } from './lib/userPrefs'
import { emailsMatch, normalizeEmail } from './lib/invitations'
import { NAME_MAX, clampLine, typedName } from './lib/names'
import { revokeMemberGrants } from './lib/projectAccess'
import { release, resolveAvatarUrl, resolveLogoUrl } from './lib/storage'
import type { EmailChange } from './lib/userPrefs'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

export const me = query({
  args: {},
  handler: async (ctx) => {
    const baUser = await authComponent.safeGetAuthUser(ctx)
    if (!baUser) return { kind: 'unauthenticated' as const }

    const user = await safeAppUser(ctx)
    if (!user) {
      return {
        kind: 'unprovisioned' as const,
        baUser: {
          id: baUser._id,
          email: baUser.email,
          name: baUser.name,
        },
      }
    }

    const memberships = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect()

    const orgs = (
      await Promise.all(
        memberships.map(async (m) => {
          const org = await ctx.db.get("organizations", m.orgId)
          // Frozen for deletion: gone from every member's app at once.
          if (!org || org.deletingAt !== undefined) return null
          return {
            _id: org._id,
            slug: org.slug,
            name: org.name,
            logoUrl: await resolveLogoUrl(ctx, org),
            role: m.role,
          }
        }),
      )
    ).filter((o): o is NonNullable<typeof o> => o !== null)

    return {
      kind: 'ready' as const,
      user: {
        _id: user._id,
        email: user.email,
        name: user.name ?? null,
        avatarUrl: await resolveAvatarUrl(ctx, user),
        superAdmin: user.superAdmin,
        lastOrgSlug: await getLastOrgSlug(ctx, user),
        preferredLanguage: user.preferredLanguage ?? null,
      },
      orgs,
    }
  },
})

export const provisionMe = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await provisionAppUser(ctx)
    return user._id
  },
})

export const updateProfile = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const user = await requireAppUser(ctx)
    await ctx.db.patch("users", user._id, { name: typedName(name) })
    return null
  },
})

export const setPreferredLanguage = mutation({
  args: { language: v.union(v.literal('en'), v.literal('fr')) },
  handler: async (ctx, { language }) => {
    const user = await requireAppUser(ctx)
    await ctx.db.patch("users", user._id, { preferredLanguage: language })
    return null
  },
})

/**
 * Internal — resolve a recipient's email locale for transactional emails sent
 * from Better Auth callbacks (which only expose a run-mutation ctx). A stored
 * preference wins; otherwise `fallback`, the language of the request that
 * triggered the email — a first sign-in code goes out before any `users` row
 * exists — and English last.
 */
export const localeForEmail = internalQuery({
  args: {
    email: v.string(),
    fallback: v.optional(v.union(v.literal('en'), v.literal('fr'))),
  },
  handler: async (ctx, { email, fallback }): Promise<'en' | 'fr'> => {
    const normalized = normalizeEmail(email)
    const user =
      (await ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', normalized))
        .first()) ??
      (await ctx.db
        .query('users')
        .withIndex('by_email', (q) => q.eq('email', email))
        .first())
    return user?.preferredLanguage ?? fallback ?? 'en'
  },
})

/**
 * Internal — called from Better Auth's `user.update.after` hook to keep the
 * Convex `users` row in sync when Better Auth mutates the account (notably an
 * email change via `changeEmail`). Without this, `users.email` goes stale and
 * the email-fallback dedup in `provisionAppUser` would re-point a victim's row
 * to any future signup reusing the freed old address — an account-takeover
 * path. Keyed on `betterAuthId` (stable), never on the email. Idempotent.
 */
export const syncBetterAuthUser = internalMutation({
  args: {
    betterAuthId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { betterAuthId, email, name }) => {
    const appUser = await ctx.db
      .query('users')
      .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', betterAuthId))
      .unique()
    if (!appUser) return null

    const patch: { email?: string; name?: string } = {}
    if (email && email !== appUser.email) patch.email = email
    // Better Auth's profile has no length or line rule of its own, and a
    // sync cannot refuse: the name is made safe rather than rejected.
    const safeName = name === undefined ? undefined : clampLine(name, NAME_MAX)
    if (safeName !== undefined && safeName !== appUser.name) {
      patch.name = safeName
    }
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch('users', appUser._id, patch)
    }
    if (patch.email) {
      await setEmailChange(ctx, appUser._id, {
        newEmail: email,
        step: 'done',
        at: Date.now(),
      })
    }
    return null
  },
})

/**
 * Organisations the user is the only owner of. Deleting the account would
 * leave each of them with nobody able to manage members or billing, so it is
 * refused until someone else is made owner — the same `last_owner` rule
 * `organizations.updateMemberRole` and `removeMember` apply.
 */
async function soleOwnedOrgs(
  ctx: GenericQueryCtx<DataModel>,
  userId: Id<'users'>,
): Promise<Array<{ _id: Id<'organizations'>; name: string; slug: string }>> {
  const memberships = await ctx.db
    .query('organizationMembers')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  const orgs = []
  for (const m of memberships) {
    if (m.role !== 'owner' || (await countOwners(ctx, m.orgId)) > 1) continue
    const org = await ctx.db.get('organizations', m.orgId)
    // One being deleted needs no owner: it will not outlive its erasure.
    if (org && org.deletingAt === undefined) {
      orgs.push({ _id: org._id, name: org.name, slug: org.slug })
    }
  }
  return orgs
}

/**
 * The platform's only super admin. Deleting them would leave nobody able to
 * reach the admin screens — the same `last_super_admin` rule
 * `admin.setSuperAdmin` applies to a self-demotion.
 */
async function isLastSuperAdmin(
  ctx: GenericQueryCtx<DataModel>,
  user: Doc<'users'>,
): Promise<boolean> {
  if (!user.superAdmin) return false
  const superAdmins = await ctx.db
    .query('users')
    .withIndex('by_superAdmin', (q) => q.eq('superAdmin', true))
    .take(2)
  return superAdmins.length < 2
}

function userByBetterAuthId(
  ctx: GenericQueryCtx<DataModel>,
  betterAuthId: string,
) {
  return ctx.db
    .query('users')
    .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', betterAuthId))
    .unique()
}

/** What stands between the caller and deleting their account. */
export const accountDeletionBlockers = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx)
    return {
      soleOwnedOrgs: await soleOwnedOrgs(ctx, user._id),
      lastSuperAdmin: await isLastSuperAdmin(ctx, user),
    }
  },
})

/** Internal — the same check, for Better Auth's delete endpoints. */
export const soleOwnedOrgNames = internalQuery({
  args: { betterAuthId: v.string() },
  handler: async (ctx, { betterAuthId }): Promise<Array<string>> => {
    const appUser = await userByBetterAuthId(ctx, betterAuthId)
    if (!appUser) return []
    return (await soleOwnedOrgs(ctx, appUser._id)).map((org) => org.name)
  },
})

/** Internal — the same check, for Better Auth's delete endpoints. */
export const lastSuperAdmin = internalQuery({
  args: { betterAuthId: v.string() },
  handler: async (ctx, { betterAuthId }): Promise<boolean> => {
    const appUser = await userByBetterAuthId(ctx, betterAuthId)
    return appUser ? await isLastSuperAdmin(ctx, appUser) : false
  },
})

/** Where the caller's last email change stands, for the profile page. */
export const emailChangeStatus = query({
  args: {},
  handler: async (ctx): Promise<EmailChange | null> => {
    const user = await requireAppUser(ctx)
    const prefs = await ctx.db
      .query('userPrefs')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .unique()
    return prefs?.emailChange ?? null
  },
})

/**
 * Internal — Better Auth accepted a change-email request: the approval link
 * is on its way to the current address (or, for an address already taken,
 * nothing is — which the profile must not reveal).
 */
export const recordEmailChangeRequested = internalMutation({
  args: { betterAuthId: v.string(), newEmail: v.string() },
  handler: async (ctx, { betterAuthId, newEmail }) => {
    const appUser = await userByBetterAuthId(ctx, betterAuthId)
    if (!appUser) return null
    await setEmailChange(ctx, appUser._id, {
      newEmail,
      step: 'approve',
      at: Date.now(),
    })
    return null
  },
})

/**
 * Internal — called when Better Auth sends a verification email. For the
 * second step of an email change it hands over the account with the NEW
 * address already swapped in, while our row still has the old one: that
 * difference is how the step is recognised. Returns what the dedicated
 * template needs, or null for an ordinary sign-up verification.
 */
export const recordEmailChangeApproved = internalMutation({
  args: { betterAuthId: v.string(), newEmail: v.string() },
  handler: async (
    ctx,
    { betterAuthId, newEmail },
  ): Promise<{ oldEmail: string; locale: 'en' | 'fr' } | null> => {
    const appUser = await userByBetterAuthId(ctx, betterAuthId)
    if (!appUser || emailsMatch(appUser.email, newEmail)) {
      return null
    }
    await setEmailChange(ctx, appUser._id, {
      newEmail,
      step: 'verify',
      at: Date.now(),
    })
    return {
      oldEmail: appUser.email,
      locale: appUser.preferredLanguage ?? 'en',
    }
  },
})

export const currentBetterAuthId = internalQuery({
  args: {},
  handler: async (ctx): Promise<string> =>
    (await requireAppUser(ctx)).betterAuthId,
})

/**
 * Add a password to an account that has none. Better Auth only exposes this
 * server-side; see `setPasswordWithFreshSession` for the rules.
 */
export const setPassword = action({
  args: { newPassword: v.string() },
  handler: async (ctx, { newPassword }): Promise<null> => {
    const betterAuthId = await ctx.runQuery(internal.users.currentBetterAuthId, {})
    const { auth, headers } = await authComponent.getAuth(createAuth, ctx)
    await setPasswordWithFreshSession(auth, headers, newPassword)
    await ctx.runMutation(internal.notifications.passwordChanged, {
      betterAuthId,
      added: true,
    })
    return null
  },
})

/**
 * Internal — called from Better Auth's `beforeDelete` hook to cascade-delete
 * all Convex-side data for a user being removed. Idempotent.
 */
export const cascadeDelete = internalMutation({
  args: { betterAuthId: v.string() },
  handler: async (ctx, { betterAuthId }) => {
    const appUser = await ctx.db
      .query('users')
      .withIndex('by_betterAuthId', (q) =>
        q.eq('betterAuthId', betterAuthId),
      )
      .unique()
    if (!appUser) return null
    // Last line of defence behind the checks on Better Auth's delete
    // endpoints: throwing here aborts the deletion before anything is gone.
    if ((await soleOwnedOrgs(ctx, appUser._id)).length > 0) {
      throw new ConvexError('sole_owner')
    }
    if (await isLastSuperAdmin(ctx, appUser)) {
      throw new ConvexError('last_super_admin')
    }

    const memberships = await ctx.db
      .query('organizationMembers')
      .withIndex('by_user', (q) => q.eq('userId', appUser._id))
      .collect()
    for (const m of memberships) {
      await ctx.db.delete("organizationMembers", m._id)
    }
    // Team places and report links, in every org at once (Back F9, h05).
    await revokeMemberGrants(ctx, appUser._id)

    const prefs = await ctx.db
      .query('userPrefs')
      .withIndex('by_user', (q) => q.eq('userId', appUser._id))
      .unique()
    if (prefs) await ctx.db.delete('userPrefs', prefs._id)

    // Objects before rows: a failed delete aborts the whole mutation, so the
    // row survives to name the blob and the next attempt retries it. A blob
    // that is already gone has nothing left to delete and is skipped.
    const avatarId = appUser.avatarStorageId
    if (avatarId && (await ctx.db.system.get('_storage', avatarId))) {
      try {
        await release(ctx, avatarId, appUser._id)
      } catch (error) {
        console.error('[cascade-delete] avatar_release_failed', {
          userId: appUser._id,
          error: String(error),
        })
        throw error
      }
    }

    await ctx.db.delete("users", appUser._id)
    return null
  },
})
