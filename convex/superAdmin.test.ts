/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'

/** Stands in for Better Auth's "who is calling": id, address, verified. */
type Identity = { subject: string; email: string; emailVerified?: boolean }
vi.mock('./auth', () => ({
  authComponent: {
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<Identity | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) throw new Error('Unauthenticated')
      return {
        _id: identity.subject,
        email: identity.email,
        name: 'x',
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

async function provision(
  t: ReturnType<typeof newTest>,
  who: string,
  emailVerified = true,
) {
  const id = await t
    .withIdentity({ subject: `ba_${who}`, email: `${who}@example.test`, emailVerified })
    .mutation(api.users.provisionMe, {})
  const row = await t.run((ctx) => ctx.db.get('users', id))
  return row!.superAdmin
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('super-admin at provisioning', () => {
  it('promotes nobody when SUPER_ADMIN_EMAIL is unset, not even the first user', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAIL', '')
    const t = newTest()
    expect(await provision(t, 'first')).toBe(false)
  })

  it('promotes only the operator address, normalised, whoever signs up first', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAIL', '  Operator@Example.TEST ')
    const t = newTest()
    expect(await provision(t, 'squatter')).toBe(false)
    expect(await provision(t, 'operator')).toBe(true)
  })

  it('never promotes an unverified address', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAIL', 'operator@example.test')
    const t = newTest()
    expect(await provision(t, 'operator', false)).toBe(false)
  })

  it('leaves existing rows as they are', async () => {
    vi.stubEnv('SUPER_ADMIN_EMAIL', '')
    const t = newTest()
    await t.run((ctx) =>
      ctx.db.insert('users', {
        betterAuthId: 'ba_legacy',
        email: 'legacy@example.test',
        superAdmin: true,
        createdAt: 0,
      }),
    )
    expect(await provision(t, 'legacy')).toBe(true)
  })
})
