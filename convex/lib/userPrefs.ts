import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from '../_generated/dataModel'

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
type MutCtx = GenericMutationCtx<DataModel>

/**
 * `lastOrgSlug` lives in `userPrefs`, NOT on the `users` row: every query
 * reads the caller's `users` row via `requireAppUser`/`safeAppUser`, so a
 * write there re-runs ALL open subscriptions. `userPrefs` is only read by
 * `users.me`, so updating it invalidates that single cheap query.
 * See KNOWN_ISSUES.md § "Hot `users` row".
 */
export async function getLastOrgSlug(
  ctx: Ctx,
  user: Doc<'users'>,
): Promise<string | null> {
  const prefs = await ctx.db
    .query('userPrefs')
    .withIndex('by_user', (q) => q.eq('userId', user._id))
    .unique()
  // Fall back to the deprecated `users.lastOrgSlug` (see schema) so users
  // created before the move to `userPrefs` keep their last viewed org until
  // it gets written here on next navigation.
  return prefs?.lastOrgSlug ?? user.lastOrgSlug ?? null
}

export type EmailChange = NonNullable<Doc<'userPrefs'>['emailChange']>

/** Record where the caller's email change stands (see the schema). */
export async function setEmailChange(
  ctx: MutCtx,
  userId: Id<'users'>,
  emailChange: EmailChange,
): Promise<void> {
  const prefs = await ctx.db
    .query('userPrefs')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .unique()
  if (!prefs) {
    await ctx.db.insert('userPrefs', { userId, emailChange })
  } else {
    await ctx.db.patch('userPrefs', prefs._id, { emailChange })
  }
}

export async function setLastOrgSlug(
  ctx: MutCtx,
  user: Doc<'users'>,
  slug: string,
): Promise<void> {
  const prefs = await ctx.db
    .query('userPrefs')
    .withIndex('by_user', (q) => q.eq('userId', user._id))
    .unique()
  if (!prefs) {
    await ctx.db.insert('userPrefs', { userId: user._id, lastOrgSlug: slug })
  } else if (prefs.lastOrgSlug !== slug) {
    await ctx.db.patch('userPrefs', prefs._id, { lastOrgSlug: slug })
  }
}
