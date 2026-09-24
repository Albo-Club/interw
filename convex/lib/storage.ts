import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'

import type { DataModel, Doc, Id } from '../_generated/dataModel'

type AnyCtx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

export async function resolveAvatarUrl(
  ctx: AnyCtx,
  user: Doc<'users'>,
): Promise<string | null> {
  if (user.avatarStorageId) {
    const url = await ctx.storage.getUrl(user.avatarStorageId)
    if (url) return url
  }
  return user.avatarUrl ?? null
}

export async function resolveLogoUrl(
  ctx: AnyCtx,
  org: Doc<'organizations'>,
): Promise<string | null> {
  if (org.logoStorageId) {
    const url = await ctx.storage.getUrl(org.logoStorageId)
    if (url) return url
  }
  return org.logoUrl ?? null
}

/**
 * Whether a row other than `self` references this blob. Convex storage has no
 * per-file owner, so our own references are the only ownership record: an
 * avatar or logo may not claim a blob someone else holds, and clearing one
 * never deletes a blob another row still points at.
 */
export async function heldElsewhere(
  ctx: GenericMutationCtx<DataModel>,
  storageId: Id<'_storage'>,
  self: Id<'users'> | Id<'organizations'>,
): Promise<boolean> {
  // `take(2)`, not `first()`: rows written before this check existed may
  // already share a blob, and `self` must not hide the other holder.
  const users = await ctx.db
    .query('users')
    .withIndex('by_avatarStorageId', (q) => q.eq('avatarStorageId', storageId))
    .take(2)
  const orgs = await ctx.db
    .query('organizations')
    .withIndex('by_logoStorageId', (q) => q.eq('logoStorageId', storageId))
    .take(2)
  return [...users, ...orgs].some((row) => row._id !== self)
}

/** Delete a blob this row is letting go of, unless another row still holds it. */
export async function release(
  ctx: GenericMutationCtx<DataModel>,
  storageId: Id<'_storage'> | undefined,
  self: Id<'users'> | Id<'organizations'>,
): Promise<void> {
  if (storageId && !(await heldElsewhere(ctx, storageId, self))) {
    await ctx.storage.delete(storageId)
  }
}
