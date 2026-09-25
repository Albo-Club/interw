/**
 * The name shown next to work a colleague did: who made a decision, who sent
 * an invitation. Removing someone from an organisation takes away their
 * access, not their credit, so the name stays — flagged `removed` so the page
 * can say so. A deleted account has no name left to show: `name` is null and
 * the page falls back to a neutral label.
 *
 * `name` falls back to the address for someone who never set one, as every
 * surface did before this helper existed; no surface learns an address it
 * was not already shown.
 */

import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Id } from '../_generated/dataModel'

export type MemberName = { name: string | null; removed: boolean }

export async function memberName(
  ctx: GenericQueryCtx<DataModel>,
  orgId: Id<'organizations'>,
  userId: Id<'users'>,
): Promise<MemberName> {
  const user = await ctx.db.get('users', userId)
  if (!user) return { name: null, removed: true }
  const membership = await ctx.db
    .query('organizationMembers')
    .withIndex('by_org_and_user', (q) =>
      q.eq('orgId', orgId).eq('userId', userId),
    )
    .unique()
  return { name: user.name ?? user.email, removed: membership === null }
}
