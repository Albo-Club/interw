/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { ConvexError } from 'convex/values'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'

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
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) throw new Error('Unauthenticated')
      return { _id: identity.subject }
    },
    registerRoutes: () => {},
  },
  createAuth: () => ({}),
}))

const sent = vi.hoisted(() => ({ count: 0 }))
vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: {
    sendEmail: () => {
      sent.count += 1
      return Promise.resolve('provider-id-stub')
    },
  },
}))

const modules = import.meta.glob('./**/*.ts')

describe('notifications.notifyPasswordChanged', () => {
  beforeEach(() => {
    sent.count = 0
  })

  // Fingerprint: convex/notifications.ts:notifyPasswordChanged:no-rate-limit
  // A public mutation that sends one email per call, bound to no actual
  // password change: without a bucket, any signed-in user could loop it.
  it('stops sending past the per-user budget', async () => {
    const t = convexTest(schema, modules)
    registerRateLimiter(t, 'rateLimiter')
    await t.run(async (ctx) => {
      await ctx.db.insert('users', {
        betterAuthId: 'ba_1',
        email: 'r@acme.test',
        superAdmin: false,
        createdAt: 0,
      })
    })
    const asUser = t.withIdentity({ subject: 'ba_1' })

    const outcomes: Array<string> = []
    for (let i = 0; i < 10; i++) {
      try {
        await asUser.mutation(api.notifications.notifyPasswordChanged, {})
        outcomes.push('sent')
      } catch (error) {
        expect(error).toBeInstanceOf(ConvexError)
        expect((error as ConvexError<{ code: string; limit: string }>).data)
          .toMatchObject({
            code: 'rate_limited',
            limit: 'passwordChangedNotify',
          })
        outcomes.push('limited')
      }
    }

    // A real password change is rare; a burst of two covers a user who
    // changes it twice in a row, and nothing beyond that is sent.
    expect(outcomes.slice(0, 2)).toEqual(['sent', 'sent'])
    expect(outcomes.slice(2).every((o) => o === 'limited')).toBe(true)
    expect(sent.count).toBe(2)
  })
})
