/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/**
 * Stands in for Better Auth's "who is calling" and nothing else. The identity
 * carries the address and whether it was verified, the two facts an
 * invitation without a token is decided on.
 */
type Identity = {
  subject: string
  email?: string
  emailVerified?: boolean
}
vi.mock('./auth', () => ({
  authComponent: {
    safeGetAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<Identity | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      return identity
        ? {
            _id: identity.subject,
            email: identity.email,
            emailVerified: identity.emailVerified ?? true,
          }
        : null
    },
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<Identity | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) throw new Error('Unauthenticated')
      return {
        _id: identity.subject,
        email: identity.email,
        emailVerified: identity.emailVerified ?? true,
      }
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

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type World = {
  acmeOrgId: Id<'organizations'>
  rivalOrgId: Id<'organizations'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<World> {
  return await t.run(async (ctx) => {
    const users: Record<string, Id<'users'>> = {}
    for (const key of ['owner', 'member', 'rivalOwner', 'newcomer']) {
      users[key] = await ctx.db.insert('users', {
        betterAuthId: `ba_${key}`,
        email: `${key}@example.test`,
        name: key === 'owner' ? 'Olivia Owner' : undefined,
        superAdmin: false,
        createdAt: 0,
      })
    }
    const acmeOrgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: users.owner,
      createdAt: 0,
    })
    const rivalOrgId = await ctx.db.insert('organizations', {
      slug: 'rival',
      name: 'Rival',
      createdBy: users.rivalOwner,
      createdAt: 0,
    })
    for (const [userId, orgId, role] of [
      [users.owner, acmeOrgId, 'owner'],
      [users.member, acmeOrgId, 'member'],
      [users.rivalOwner, rivalOrgId, 'owner'],
    ] as Array<[Id<'users'>, Id<'organizations'>, 'owner' | 'member']>) {
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role,
        joinedAt: 0,
      })
    }
    return { acmeOrgId, rivalOrgId }
  })
}

const as = (
  t: ReturnType<typeof newTest>,
  who: string,
  emailVerified = true,
) =>
  t.withIdentity({
    subject: `ba_${who}`,
    email: `${who}@example.test`,
    emailVerified,
  })

describe('creating an invitation', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('refuses to invite someone who is already a member', async () => {
    await expect(
      as(t, 'owner').mutation(api.invitations.create, {
        orgId: w.acmeOrgId,
        email: 'Member@Example.test ',
        role: 'member',
      }),
    ).rejects.toThrow('already_member')
  })

  it('refuses a self-invitation', async () => {
    await expect(
      as(t, 'owner').mutation(api.invitations.create, {
        orgId: w.acmeOrgId,
        email: 'owner@example.test',
        role: 'admin',
      }),
    ).rejects.toThrow('already_member')
  })

  it('still refuses a second live invitation to the same address', async () => {
    await as(t, 'owner').mutation(api.invitations.create, {
      orgId: w.acmeOrgId,
      email: 'newcomer@example.test',
      role: 'member',
    })
    await expect(
      as(t, 'owner').mutation(api.invitations.create, {
        orgId: w.acmeOrgId,
        email: 'newcomer@example.test',
        role: 'member',
      }),
    ).rejects.toThrow('already_invited')
  })

  it('replaces an expired invitation instead of blocking the re-invite', async () => {
    const first = await as(t, 'owner').mutation(api.invitations.create, {
      orgId: w.acmeOrgId,
      email: 'newcomer@example.test',
      role: 'member',
    })
    await t.run((ctx) =>
      ctx.db.patch('invitations', first, { expiresAt: Date.now() - 1 }),
    )

    const second = await as(t, 'owner').mutation(api.invitations.create, {
      orgId: w.acmeOrgId,
      email: 'newcomer@example.test',
      role: 'admin',
    })

    const rows = await t.run((ctx) =>
      ctx.db
        .query('invitations')
        .withIndex('by_email_and_org', (q) =>
          q.eq('email', 'newcomer@example.test').eq('orgId', w.acmeOrgId),
        )
        .collect(),
    )
    expect(rows.map((r) => r._id)).toEqual([second])
    expect(rows[0].role).toBe('admin')
    expect(rows[0].expiresAt).toBeGreaterThan(Date.now())
  })

  it('logs the send so a bounce can reach the pending row', async () => {
    await as(t, 'owner').mutation(api.invitations.create, {
      orgId: w.acmeOrgId,
      email: 'newcomer@example.test',
      role: 'member',
    })
    const [pending] = await as(t, 'owner').query(api.invitations.listForOrg, {
      orgId: w.acmeOrgId,
    })
    expect(pending.deliveryStatus).toBe('sent')
    expect(pending.invitedBy).toEqual({ name: 'Olivia Owner', removed: false })

    // Resend's webhook, as the component delivers it.
    const now = new Date().toISOString()
    await t.mutation(internal.emailEvents.record, {
      id: 'provider-id-stub' as never,
      event: {
        type: 'email.bounced',
        created_at: now,
        data: {
          created_at: now,
          email_id: 'provider-id-stub',
          from: 'interw <no-reply@example.test>',
          to: 'newcomer@example.test',
          subject: 'Invitation',
          bounce: {
            message: 'mailbox full',
            subType: 'General',
            type: 'Permanent',
          },
        },
      },
    })
    const [after] = await as(t, 'owner').query(api.invitations.listForOrg, {
      orgId: w.acmeOrgId,
    })
    expect(after.deliveryStatus).toBe('bounced')
  })

  it('still credits an inviter removed from the organisation since', async () => {
    await t.run(async (ctx) => {
      const member = await ctx.db
        .query('users')
        .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', 'ba_member'))
        .unique()
      await ctx.db.insert('invitations', {
        orgId: w.acmeOrgId,
        email: 'newcomer@example.test',
        role: 'member',
        token: 'invite-from-a-former-member',
        invitedBy: member!._id,
        expiresAt: Date.now() + 60_000,
      })
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', w.acmeOrgId).eq('userId', member!._id),
        )
        .unique()
      await ctx.db.delete('organizationMembers', membership!._id)
    })

    const [pending] = await as(t, 'owner').query(api.invitations.listForOrg, {
      orgId: w.acmeOrgId,
    })
    // The address stands in for a name, exactly as it did before removal.
    expect(pending.invitedBy).toEqual({
      name: 'member@example.test',
      removed: true,
    })
  })
})

describe('resending an invitation', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('extends the expiry, keeps the link and logs a second send', async () => {
    const invitationId = await as(t, 'owner').mutation(
      api.invitations.create,
      { orgId: w.acmeOrgId, email: 'newcomer@example.test', role: 'member' },
    )
    await t.run((ctx) =>
      ctx.db.patch('invitations', invitationId, { expiresAt: 1 }),
    )
    const before = await t.run((ctx) => ctx.db.get('invitations', invitationId))

    await as(t, 'owner').mutation(api.invitations.resendInvitation, { invitationId })

    const after = await t.run((ctx) => ctx.db.get('invitations', invitationId))
    expect(after?.token).toBe(before?.token)
    expect(after!.expiresAt).toBeGreaterThan(Date.now())
    const sends = await t.run((ctx) =>
      ctx.db
        .query('emailLog')
        .withIndex('by_invitation', (q) => q.eq('invitationId', invitationId))
        .collect(),
    )
    expect(sends).toHaveLength(2)
  })

  it('is an admin action', async () => {
    const invitationId = await as(t, 'owner').mutation(
      api.invitations.create,
      { orgId: w.acmeOrgId, email: 'newcomer@example.test', role: 'member' },
    )
    await expect(
      as(t, 'member').mutation(api.invitations.resendInvitation, { invitationId }),
    ).rejects.toThrow('insufficient_role')
    await expect(
      as(t, 'rivalOwner').mutation(api.invitations.resendInvitation, { invitationId }),
    ).rejects.toThrow('not_a_member')
  })
})

describe('the invitations waiting for the signed-in user', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  async function invite(orgId: Id<'organizations'>, email: string) {
    const inviter = orgId === w.acmeOrgId ? 'owner' : 'rivalOwner'
    return await as(t, inviter).mutation(api.invitations.create, {
      orgId,
      email,
      role: 'admin',
    })
  }

  it('lists only invitations addressed to the caller', async () => {
    await invite(w.acmeOrgId, 'newcomer@example.test')
    await invite(w.rivalOrgId, 'someone-else@example.test')

    const mine = await as(t, 'newcomer').query(api.invitations.listMine, {})
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({
      orgName: 'Acme',
      inviterName: 'Olivia Owner',
      role: 'admin',
    })
    // Never the credential: accepting from here goes through the id and a
    // server-side address check.
    expect(JSON.stringify(mine)).not.toMatch(/token/i)

    const theirs = await as(t, 'member').query(api.invitations.listMine, {})
    expect(theirs).toEqual([])
  })

  it('hides, and refuses, an organisation being deleted', async () => {
    const invitationId = await invite(w.acmeOrgId, 'newcomer@example.test')
    await t.run((ctx) =>
      ctx.db.patch('organizations', w.acmeOrgId, { deletingAt: Date.now() }),
    )
    expect(
      await as(t, 'newcomer').query(api.invitations.listMine, {}),
    ).toEqual([])
    await expect(
      as(t, 'newcomer').mutation(api.invitations.acceptById, { invitationId }),
    ).rejects.toThrow('not_found')
  })

  it('shows nothing to an unverified address', async () => {
    await invite(w.acmeOrgId, 'newcomer@example.test')
    const mine = await as(t, 'newcomer', false).query(
      api.invitations.listMine,
      {},
    )
    expect(mine).toEqual([])
  })

  it('accepts by id for the invited address', async () => {
    const invitationId = await invite(w.acmeOrgId, 'newcomer@example.test')
    const result = await as(t, 'newcomer').mutation(
      api.invitations.acceptById,
      { invitationId },
    )
    expect(result).toMatchObject({
      orgSlug: 'acme',
      orgName: 'Acme',
      role: 'admin',
      joined: true,
    })
    const mine = await as(t, 'newcomer').query(api.invitations.listMine, {})
    expect(mine).toEqual([])
  })

  it('refuses to accept by id for any other address', async () => {
    const invitationId = await invite(w.acmeOrgId, 'newcomer@example.test')
    await expect(
      as(t, 'rivalOwner').mutation(api.invitations.acceptById, {
        invitationId,
      }),
    ).rejects.toThrow('not_found')
    const members = await t.run((ctx) =>
      ctx.db
        .query('organizationMembers')
        .withIndex('by_org', (q) => q.eq('orgId', w.acmeOrgId))
        .collect(),
    )
    expect(members).toHaveLength(2)
  })

  it('refuses to accept by id from an unverified address', async () => {
    const invitationId = await invite(w.acmeOrgId, 'newcomer@example.test')
    await expect(
      as(t, 'newcomer', false).mutation(api.invitations.acceptById, {
        invitationId,
      }),
    ).rejects.toThrow('not_found')
  })

  it('refuses an expired invitation by id', async () => {
    const invitationId = await invite(w.acmeOrgId, 'newcomer@example.test')
    await t.run((ctx) =>
      ctx.db.patch('invitations', invitationId, { expiresAt: 1 }),
    )
    await expect(
      as(t, 'newcomer').mutation(api.invitations.acceptById, { invitationId }),
    ).rejects.toThrow('expired')
  })
})

describe('accepting by token', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('tells a fresh join from an existing member re-opening the link', async () => {
    const invitationId = await as(t, 'owner').mutation(
      api.invitations.create,
      { orgId: w.acmeOrgId, email: 'newcomer@example.test', role: 'member' },
    )
    const inv = await t.run((ctx) => ctx.db.get('invitations', invitationId))
    const first = await as(t, 'newcomer').mutation(api.invitations.accept, {
      token: inv!.token,
    })
    expect(first).toMatchObject({ orgSlug: 'acme', joined: true })
    const again = await as(t, 'newcomer').mutation(api.invitations.accept, {
      token: inv!.token,
    })
    expect(again).toMatchObject({ orgSlug: 'acme', joined: false })
  })

  it("never lets a member consume someone else's invitation", async () => {
    const invitationId = await as(t, 'owner').mutation(
      api.invitations.create,
      { orgId: w.acmeOrgId, email: 'newcomer@example.test', role: 'member' },
    )
    const inv = await t.run((ctx) => ctx.db.get('invitations', invitationId))
    // A member holding the link lands in the org, as for their own link...
    const member = await as(t, 'member').mutation(api.invitations.accept, {
      token: inv!.token,
    })
    expect(member).toMatchObject({ orgSlug: 'acme', joined: false })
    // ...but the invitation stays the invitee's.
    const after = await t.run((ctx) => ctx.db.get('invitations', invitationId))
    expect(after?.acceptedAt).toBeUndefined()
    const invitee = await as(t, 'newcomer').mutation(api.invitations.accept, {
      token: inv!.token,
    })
    expect(invitee).toMatchObject({ orgSlug: 'acme', joined: true })
  })
})

/**
 * Audit T12 (h05): an invitation speaks for the admin who sent it. Once they
 * are removed from the organisation, demoted below admin, or gone altogether,
 * it must stop working — exactly like one that never existed.
 */
describe('an invitation whose inviter can no longer invite', () => {
  let t: ReturnType<typeof newTest>
  let w: World
  let adminMemberId: Id<'organizationMembers'>

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
    adminMemberId = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        betterAuthId: 'ba_admin',
        email: 'admin@example.test',
        name: 'Adam Admin',
        superAdmin: false,
        createdAt: 0,
      })
      return await ctx.db.insert('organizationMembers', {
        orgId: w.acmeOrgId,
        userId,
        role: 'admin',
        joinedAt: 0,
      })
    })
  })

  async function inviteAsAdmin() {
    const invitationId = await as(t, 'admin').mutation(api.invitations.create, {
      orgId: w.acmeOrgId,
      email: 'newcomer@example.test',
      role: 'member',
    })
    const inv = await t.run((ctx) => ctx.db.get('invitations', invitationId))
    return { invitationId, token: inv!.token }
  }

  const removeAdmin = () =>
    as(t, 'owner').mutation(api.organizations.removeMember, {
      orgId: w.acmeOrgId,
      memberId: adminMemberId,
    })

  it('works while the inviter is still an admin', async () => {
    const { token } = await inviteAsAdmin()
    expect(
      await as(t, 'newcomer').query(api.invitations.listMine, {}),
    ).toMatchObject([{ inviterName: 'Adam Admin' }])
    await expect(
      as(t, 'newcomer').mutation(api.invitations.accept, { token }),
    ).resolves.toMatchObject({ joined: true })
  })

  it('fails like an unknown token once the inviter is removed', async () => {
    const { invitationId, token } = await inviteAsAdmin()
    await removeAdmin()

    expect(await t.query(api.invitations.preview, { token })).toEqual({
      kind: 'not_found',
    })
    await expect(
      as(t, 'newcomer').mutation(api.invitations.accept, { token }),
    ).rejects.toThrow('not_found')
    await expect(
      as(t, 'newcomer').mutation(api.invitations.acceptById, { invitationId }),
    ).rejects.toThrow('not_found')
    expect(await as(t, 'newcomer').query(api.invitations.listMine, {})).toEqual(
      [],
    )
    const members = await t.run((ctx) =>
      ctx.db
        .query('organizationMembers')
        .withIndex('by_org', (q) => q.eq('orgId', w.acmeOrgId))
        .collect(),
    )
    expect(members).toHaveLength(2)
  })

  it('fails once the inviter is demoted to member', async () => {
    const { token } = await inviteAsAdmin()
    await as(t, 'owner').mutation(api.organizations.updateMemberRole, {
      orgId: w.acmeOrgId,
      memberId: adminMemberId,
      role: 'member',
    })
    await expect(
      as(t, 'newcomer').mutation(api.invitations.accept, { token }),
    ).rejects.toThrow('not_found')
  })

  it('is marked for the admins, and is neither resent nor linked', async () => {
    const { invitationId } = await inviteAsAdmin()
    await removeAdmin()

    const [row] = await as(t, 'owner').query(api.invitations.listForOrg, {
      orgId: w.acmeOrgId,
    })
    expect(row).toMatchObject({
      _id: invitationId,
      invalidated: true,
      invitedBy: { name: 'Adam Admin', removed: true },
    })
    await expect(
      as(t, 'owner').mutation(api.invitations.resendInvitation, {
        invitationId,
      }),
    ).rejects.toThrow('not_found')
    await expect(
      as(t, 'owner').query(api.invitations.link, { invitationId }),
    ).rejects.toThrow('not_found')
    const sends = await t.run((ctx) =>
      ctx.db
        .query('emailLog')
        .withIndex('by_invitation', (q) => q.eq('invitationId', invitationId))
        .collect(),
    )
    expect(sends).toHaveLength(1)
  })

  it('does not block inviting the same address again', async () => {
    const { invitationId } = await inviteAsAdmin()
    await removeAdmin()

    const again = await as(t, 'owner').mutation(api.invitations.create, {
      orgId: w.acmeOrgId,
      email: 'newcomer@example.test',
      role: 'member',
    })
    expect(again).not.toBe(invitationId)
    const [row] = await as(t, 'owner').query(api.invitations.listForOrg, {
      orgId: w.acmeOrgId,
    })
    expect(row).toMatchObject({ _id: again, invalidated: false })
  })

  it('an accepted one stays accepted', async () => {
    const { token } = await inviteAsAdmin()
    await as(t, 'newcomer').mutation(api.invitations.accept, { token })
    await removeAdmin()
    await expect(
      as(t, 'newcomer').mutation(api.invitations.accept, { token }),
    ).resolves.toMatchObject({ joined: false })
    // The accepted-link page names nobody: it has no use for the inviter.
    expect(await t.query(api.invitations.preview, { token })).toEqual({
      kind: 'already_accepted',
      orgName: 'Acme',
    })
  })
})

describe('creating a second organisation', () => {
  it('works for someone who already has one, and caps the name', async () => {
    const t = newTest()
    await seed(t)
    const created = await as(t, 'owner').mutation(api.organizations.create, {
      name: 'Acme Labs',
      slug: 'acme-labs',
    })
    expect(created.slug).toBe('acme-labs')
    await expect(
      as(t, 'owner').mutation(api.organizations.create, {
        name: 'x'.repeat(81),
        slug: 'too-long',
      }),
    ).rejects.toThrow('invalid_name')
  })

  // Audit T12 (h10): the name goes into email subjects.
  it('stores the name on one line', async () => {
    const t = newTest()
    const w = await seed(t)
    const { orgId } = await as(t, 'owner').mutation(api.organizations.create, {
      name: 'Acme\r\nBcc: victim@example.test',
      slug: 'acme-crlf',
    })
    await as(t, 'owner').mutation(api.organizations.updateGeneral, {
      orgId: w.acmeOrgId,
      name: 'Acme\nRenamed',
    })
    const names = await t.run(async (ctx) => [
      (await ctx.db.get('organizations', orgId))?.name,
      (await ctx.db.get('organizations', w.acmeOrgId))?.name,
    ])
    expect(names).toEqual(['Acme Bcc: victim@example.test', 'Acme Renamed'])
  })
})

describe('the team-invite sends', () => {
  let t: ReturnType<typeof newTest>
  let w: World
  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('go with the invitation when it is revoked', async () => {
    const invitationId = await as(t, 'owner').mutation(
      api.invitations.create,
      { orgId: w.acmeOrgId, email: 'newcomer@example.test', role: 'member' },
    )
    await as(t, 'owner').mutation(api.invitations.revoke, { invitationId })
    const sends = await t.run((ctx) =>
      ctx.db
        .query('emailLog')
        .withIndex('by_invitation', (q) => q.eq('invitationId', invitationId))
        .collect(),
    )
    expect(sends).toEqual([])
  })
})
