/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

// Better Auth resolves the caller through its own component, which
// `convex-test` does not run; this stands in for "who is calling" only.
vi.mock('./auth', () => ({
  authComponent: {
    safeGetAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      return identity ? { _id: identity.subject } : null
    },
    registerRoutes: () => {},
  },
  createAuth: () => ({}),
}))

vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: { sendEmail: () => Promise.resolve('provider-id-stub') },
}))

const modules = import.meta.glob('./**/*.ts')

/** Alice owns Acme; `coOwner` decides whether she owns it alone. */
async function world(coOwner: boolean) {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  const ids = await t.run(async (ctx) => {
    const insertUser = (key: string) =>
      ctx.db.insert('users', {
        betterAuthId: `ba_${key}`,
        email: `${key}@example.test`,
        superAdmin: false,
        createdAt: 0,
      })
    const alice = await insertUser('alice')
    const bob = await insertUser('bob')
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: alice,
      createdAt: 0,
    })
    const member = (userId: Id<'users'>, role: 'owner' | 'member') =>
      ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role,
        joinedAt: 0,
      })
    await member(alice, 'owner')
    await member(bob, coOwner ? 'owner' : 'member')
    return { alice, bob, orgId }
  })
  return { t, ...ids }
}

describe('account deletion and sole ownership', () => {
  it('refuses to delete the only owner of an organisation', async () => {
    const { t, alice } = await world(false)

    expect(
      await t
        .withIdentity({ subject: 'ba_alice' })
        .query(api.users.accountDeletionBlockers, {}),
    ).toMatchObject({
      soleOwnedOrgs: [{ name: 'Acme', slug: 'acme' }],
      lastSuperAdmin: false,
    })
    expect(
      await t.query(internal.users.soleOwnedOrgNames, {
        betterAuthId: 'ba_alice',
      }),
    ).toEqual(['Acme'])

    await expect(
      t.mutation(internal.users.cascadeDelete, { betterAuthId: 'ba_alice' }),
    ).rejects.toThrow('sole_owner')
    await t.run(async (ctx) => {
      expect(await ctx.db.get('users', alice)).not.toBeNull()
      const memberships = await ctx.db
        .query('organizationMembers')
        .withIndex('by_user', (q) => q.eq('userId', alice))
        .collect()
      expect(memberships).toHaveLength(1)
    })
  })

  it('lets an owner go once another owner remains', async () => {
    const { t, alice, orgId } = await world(true)
    expect(
      await t
        .withIdentity({ subject: 'ba_alice' })
        .query(api.users.accountDeletionBlockers, {}),
    ).toEqual({ soleOwnedOrgs: [], lastSuperAdmin: false })

    await t.mutation(internal.users.cascadeDelete, { betterAuthId: 'ba_alice' })
    await t.run(async (ctx) => {
      expect(await ctx.db.get('users', alice)).toBeNull()
      const members = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org', (q) => q.eq('orgId', orgId))
        .collect()
      expect(members.map((m) => m.role)).toEqual(['owner'])
    })
  })

  it('never blocks a plain member', async () => {
    const { t, bob } = await world(false)
    await t.mutation(internal.users.cascadeDelete, { betterAuthId: 'ba_bob' })
    await t.run(async (ctx) => {
      expect(await ctx.db.get('users', bob)).toBeNull()
    })
  })
})

describe('account deletion and the last super admin', () => {
  const promote = (t: Awaited<ReturnType<typeof world>>['t'], userId: Id<'users'>) =>
    t.run((ctx) => ctx.db.patch('users', userId, { superAdmin: true }))

  it('refuses to delete the only super admin', async () => {
    const { t, bob } = await world(false)
    await promote(t, bob)

    expect(
      await t
        .withIdentity({ subject: 'ba_bob' })
        .query(api.users.accountDeletionBlockers, {}),
    ).toEqual({ soleOwnedOrgs: [], lastSuperAdmin: true })
    expect(
      await t.query(internal.users.lastSuperAdmin, { betterAuthId: 'ba_bob' }),
    ).toBe(true)
    await expect(
      t.mutation(internal.users.cascadeDelete, { betterAuthId: 'ba_bob' }),
    ).rejects.toThrow('last_super_admin')
    await t.run(async (ctx) => {
      expect(await ctx.db.get('users', bob)).not.toBeNull()
    })
  })

  it('lets a super admin go once another one remains', async () => {
    const { t, alice, bob } = await world(true)
    await promote(t, alice)
    await promote(t, bob)

    expect(
      await t
        .withIdentity({ subject: 'ba_bob' })
        .query(api.users.accountDeletionBlockers, {}),
    ).toEqual({ soleOwnedOrgs: [], lastSuperAdmin: false })
    expect(
      await t.query(internal.users.lastSuperAdmin, { betterAuthId: 'ba_bob' }),
    ).toBe(false)
    await t.mutation(internal.users.cascadeDelete, { betterAuthId: 'ba_bob' })
    await t.run(async (ctx) => {
      expect(await ctx.db.get('users', bob)).toBeNull()
    })
  })
})

describe('email change progress', () => {
  it('follows the request through approval to the switch', async () => {
    const { t } = await world(false)
    const asAlice = t.withIdentity({ subject: 'ba_alice' })
    expect(await asAlice.query(api.users.emailChangeStatus, {})).toBeNull()

    await t.mutation(internal.users.recordEmailChangeRequested, {
      betterAuthId: 'ba_alice',
      newEmail: 'new@example.test',
    })
    expect(await asAlice.query(api.users.emailChangeStatus, {})).toMatchObject(
      { newEmail: 'new@example.test', step: 'approve' },
    )

    // Better Auth mails the new address with the account's email swapped in.
    expect(
      await t.mutation(internal.users.recordEmailChangeApproved, {
        betterAuthId: 'ba_alice',
        newEmail: 'new@example.test',
      }),
    ).toEqual({ oldEmail: 'alice@example.test', locale: 'en' })
    expect(await asAlice.query(api.users.emailChangeStatus, {})).toMatchObject(
      { step: 'verify' },
    )

    await t.mutation(internal.users.syncBetterAuthUser, {
      betterAuthId: 'ba_alice',
      email: 'new@example.test',
    })
    expect(await asAlice.query(api.users.emailChangeStatus, {})).toMatchObject(
      { newEmail: 'new@example.test', step: 'done' },
    )
  })

  it('leaves a sign-up verification alone', async () => {
    const { t } = await world(false)
    expect(
      await t.mutation(internal.users.recordEmailChangeApproved, {
        betterAuthId: 'ba_alice',
        newEmail: 'Alice@Example.test',
      }),
    ).toBeNull()
    expect(
      await t.mutation(internal.users.recordEmailChangeApproved, {
        betterAuthId: 'ba_not_provisioned_yet',
        newEmail: 'someone@example.test',
      }),
    ).toBeNull()
    expect(
      await t
        .withIdentity({ subject: 'ba_alice' })
        .query(api.users.emailChangeStatus, {}),
    ).toBeNull()
  })
})
