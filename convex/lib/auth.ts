import { ConvexError } from 'convex/values'
import { authComponent } from '../auth'
import { RESEND_FROM, resend } from '../email'
import { newUserSignupNotificationEmail } from '../emailTemplates'
import { normalizeEmail } from './invitations'
import { singleLine } from './singleLine'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from '../_generated/dataModel'

/** Same cap as the profile form; enforced on every way a name comes in. */
export const USER_NAME_MAX = 80

/** A user name as Better Auth hands it over: one line, capped. */
export function cleanUserName(name: string): string {
  return singleLine(name).slice(0, USER_NAME_MAX)
}

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
type MutCtx = GenericMutationCtx<DataModel>

export type AppRole = 'owner' | 'admin' | 'member'

const roleRank: Record<AppRole, number> = {
  owner: 2,
  admin: 1,
  member: 0,
}

/** Whether `role` is at least `minRole` (owner > admin > member). */
export function hasRole(role: AppRole, minRole: AppRole): boolean {
  return roleRank[role] >= roleRank[minRole]
}

export async function safeAppUser(ctx: Ctx): Promise<Doc<'users'> | null> {
  const baUser = await authComponent.safeGetAuthUser(ctx)
  if (!baUser) return null
  return await ctx.db
    .query('users')
    .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', baUser._id))
    .unique()
}

export async function requireAppUser(ctx: Ctx): Promise<Doc<'users'>> {
  const user = await safeAppUser(ctx)
  if (!user) throw new ConvexError('unprovisioned_or_unauthenticated')
  return user
}

/**
 * Mutation-only: return the current app user, creating the row on first call
 * if Better Auth has the user but our Convex `users` table doesn't yet.
 * A new row is `superAdmin` only for the operator's verified address
 * (`isOperator`); an existing row keeps whatever flag it has.
 *
 * Dedup strategy (anti-doublon):
 *   1. Lookup by `betterAuthId` — happy path for returning users.
 *   2. Fallback lookup by `email` — covers the case where Better Auth linked
 *      accounts on its side (different `betterAuthId`, same email) but our
 *      `users` table hasn't seen the new BA id yet. We re-point the existing
 *      row's `betterAuthId` to the current BA user instead of inserting a
 *      duplicate. This also heals legacy duplicates as users come back in.
 *   3. Insert only if neither match succeeds.
 */
export async function provisionAppUser(ctx: MutCtx): Promise<Doc<'users'>> {
  const baUser = await authComponent.getAuthUser(ctx)
  const byBetterAuthId = await ctx.db
    .query('users')
    .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', baUser._id))
    .unique()
  if (byBetterAuthId) return byBetterAuthId

  const byEmail = await ctx.db
    .query('users')
    .withIndex('by_email', (q) => q.eq('email', baUser.email))
    .first()
  if (byEmail) {
    await ctx.db.patch("users", byEmail._id, { betterAuthId: baUser._id })
    const refreshed = await ctx.db.get("users", byEmail._id)
    if (!refreshed) throw new ConvexError('provision_failed')
    return refreshed
  }

  const probe = await ctx.db.query('users').take(1)
  const isFirst = probe.length === 0
  const userId = await ctx.db.insert('users', {
    betterAuthId: baUser._id,
    email: baUser.email,
    name: cleanUserName(baUser.name),
    avatarUrl: baUser.image ?? undefined,
    superAdmin: isOperator(baUser),
    createdAt: Date.now(),
  })
  const created = await ctx.db.get("users", userId)
  if (!created) throw new ConvexError('provision_failed')

  // Dev-only signup notification. Sent only on the insert branch above, so it
  // fires once per user (the dedup branches return early). Failures must never
  // roll back the provisioning — same contract as convex/notifications.ts.
  const devNotifyTo = process.env.DEV_NOTIFY_EMAIL
  if (devNotifyTo) {
    try {
      const { subject, html, text } = newUserSignupNotificationEmail({
        email: created.email,
        name: created.name,
        betterAuthId: created.betterAuthId,
        isFirst,
      })
      await resend.sendEmail(ctx, {
        from: RESEND_FROM,
        to: devNotifyTo,
        subject,
        html,
        text,
      })
    } catch (err) {
      console.warn('dev signup notification failed', err)
    }
  }

  return created
}

/**
 * Super-admin is pinned to one operator address, `SUPER_ADMIN_EMAIL`, never
 * to "whoever registers first": on an empty deployment (a fresh one, or after
 * `admin.purgeExcept`) that was anyone who got there before the operator.
 * Unset means nobody is promoted. See KNOWN_ISSUES.md § "Super-admin is the
 * operator's address, not the first sign-up".
 */
function isOperator(baUser: { email: string; emailVerified: boolean }) {
  const operator = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? '')
  return (
    !!operator &&
    baUser.emailVerified &&
    normalizeEmail(baUser.email) === operator
  )
}

export async function requireOrgMember(
  ctx: Ctx,
  orgId: Id<'organizations'>,
): Promise<{
  user: Doc<'users'>
  member: Doc<'organizationMembers'>
  org: Doc<'organizations'>
}> {
  const user = await requireAppUser(ctx)
  const member = await ctx.db
    .query('organizationMembers')
    .withIndex('by_org_and_user', (q) =>
      q.eq('orgId', orgId).eq('userId', user._id),
    )
    .unique()
  if (!member) throw new ConvexError('not_a_member')
  // An organisation being deleted is frozen for everyone, its owners
  // included: nothing may be written into it while erasure collects what to
  // delete. Checked after membership, so the code tells a non-member nothing.
  const org = await ctx.db.get('organizations', orgId)
  if (!org || org.deletingAt !== undefined) {
    throw new ConvexError('org_deleting')
  }
  return { user, member, org }
}

export async function requireOrgRole(
  ctx: Ctx,
  orgId: Id<'organizations'>,
  minRole: AppRole,
): Promise<{
  user: Doc<'users'>
  member: Doc<'organizationMembers'>
  org: Doc<'organizations'>
}> {
  const { user, member, org } = await requireOrgMember(ctx, orgId)
  if (!hasRole(member.role, minRole)) {
    throw new ConvexError('insufficient_role')
  }
  return { user, member, org }
}

export async function requireSuperAdmin(ctx: Ctx): Promise<Doc<'users'>> {
  const user = await requireAppUser(ctx)
  if (!user.superAdmin) throw new ConvexError('not_super_admin')
  return user
}
