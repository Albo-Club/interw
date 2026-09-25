import { ConvexError, v } from 'convex/values'
import { mutation } from './_generated/server'
import { requireAppUser, requireOrgRole } from './lib/auth'
import { heldElsewhere, release } from './lib/storage'
import { consumeLimit } from './rateLimiters'
import type { GenericMutationCtx } from 'convex/server'

import type { DataModel, Id } from './_generated/dataModel'

const MAX_BYTES = 20 * 1024 * 1024
const ALLOWED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]

async function validateImage(
  ctx: GenericMutationCtx<DataModel>,
  storageId: Id<'_storage'>,
): Promise<void> {
  const meta = await ctx.db.system.get("_storage", storageId)
  if (!meta) throw new ConvexError('not_found')
  if (meta.size > MAX_BYTES) {
    await ctx.storage.delete(storageId)
    throw new ConvexError('too_large')
  }
  if (meta.contentType && !ALLOWED_IMAGE_TYPES.includes(meta.contentType)) {
    await ctx.storage.delete(storageId)
    throw new ConvexError('invalid_type')
  }
}

/** Checked before `validateImage`, which deletes a blob it rejects. */
async function claim(
  ctx: GenericMutationCtx<DataModel>,
  storageId: Id<'_storage'>,
  self: Id<'users'> | Id<'organizations'>,
): Promise<void> {
  // Same refusal as an id that does not exist: the caller learns nothing
  // about whose blob it is.
  if (await heldElsewhere(ctx, storageId, self)) {
    throw new ConvexError('not_found')
  }
  await validateImage(ctx, storageId)
}

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx)
    await consumeLimit(ctx, 'storageUpload', user._id)
    return await ctx.storage.generateUploadUrl()
  },
})

export const setMyAvatar = mutation({
  args: { storageId: v.id('_storage') },
  handler: async (ctx, { storageId }) => {
    const user = await requireAppUser(ctx)
    await claim(ctx, storageId, user._id)
    if (user.avatarStorageId !== storageId) {
      await release(ctx, user.avatarStorageId, user._id)
    }
    await ctx.db.patch("users", user._id, {
      avatarStorageId: storageId,
      avatarUrl: undefined,
    })
    return null
  },
})

export const removeMyAvatar = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireAppUser(ctx)
    await release(ctx, user.avatarStorageId, user._id)
    await ctx.db.patch("users", user._id, {
      avatarStorageId: undefined,
      avatarUrl: undefined,
    })
    return null
  },
})

export const setOrgLogo = mutation({
  args: { orgId: v.id('organizations'), storageId: v.id('_storage') },
  handler: async (ctx, { orgId, storageId }) => {
    await requireOrgRole(ctx, orgId, 'admin')
    await claim(ctx, storageId, orgId)
    const org = await ctx.db.get("organizations", orgId)
    if (org?.logoStorageId !== storageId) {
      await release(ctx, org?.logoStorageId, orgId)
    }
    await ctx.db.patch("organizations", orgId, {
      logoStorageId: storageId,
      logoUrl: undefined,
    })
    return null
  },
})

export const removeOrgLogo = mutation({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgRole(ctx, orgId, 'admin')
    const org = await ctx.db.get("organizations", orgId)
    await release(ctx, org?.logoStorageId, orgId)
    await ctx.db.patch("organizations", orgId, {
      logoStorageId: undefined,
      logoUrl: undefined,
    })
    return null
  },
})
