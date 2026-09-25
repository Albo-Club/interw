/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it } from 'vitest'

import schema from '../schema'
import { memberName } from './memberName'

const modules = import.meta.glob('../**/*.ts')

async function world() {
  const t = convexTest(schema, modules)
  const ids = await t.run(async (ctx) => {
    const user = (key: string, name?: string) =>
      ctx.db.insert('users', {
        betterAuthId: `ba_${key}`,
        email: `${key}@example.test`,
        name,
        superAdmin: false,
        createdAt: 0,
      })
    const named = await user('named', 'Nora Named')
    const unnamed = await user('unnamed')
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: named,
      createdAt: 0,
    })
    const otherOrgId = await ctx.db.insert('organizations', {
      slug: 'rival',
      name: 'Rival',
      createdBy: unnamed,
      createdAt: 0,
    })
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId: named,
      role: 'member',
      joinedAt: 0,
    })
    await ctx.db.insert('organizationMembers', {
      orgId: otherOrgId,
      userId: unnamed,
      role: 'owner',
      joinedAt: 0,
    })
    return { named, unnamed, orgId }
  })
  return { t, ...ids }
}

describe('memberName', () => {
  it('names a current member', async () => {
    const { t, named, orgId } = await world()
    expect(await t.run((ctx) => memberName(ctx, orgId, named))).toEqual({
      name: 'Nora Named',
      removed: false,
    })
  })

  it('keeps the name of someone no longer in this organisation', async () => {
    const { t, named, orgId } = await world()
    await t.run(async (ctx) => {
      const [membership] = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user', (q) => q.eq('userId', named))
        .collect()
      await ctx.db.delete('organizationMembers', membership._id)
    })
    expect(await t.run((ctx) => memberName(ctx, orgId, named))).toEqual({
      name: 'Nora Named',
      removed: true,
    })
  })

  it('reads membership of this organisation, not of any', async () => {
    const { t, unnamed, orgId } = await world()
    expect(await t.run((ctx) => memberName(ctx, orgId, unnamed))).toEqual({
      name: 'unnamed@example.test',
      removed: true,
    })
  })

  it('has no name left for a deleted account', async () => {
    const { t, named, orgId } = await world()
    await t.run((ctx) => ctx.db.delete('users', named))
    expect(await t.run((ctx) => memberName(ctx, orgId, named))).toEqual({
      name: null,
      removed: true,
    })
  })
})
