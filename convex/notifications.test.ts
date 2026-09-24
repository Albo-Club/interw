/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'

// Better Auth runs in its own component, which `convex-test` does not load.
vi.mock('./auth', () => ({
  authComponent: { registerRoutes: () => {} },
  createAuth: () => ({}),
}))

const sent = vi.hoisted(() => ({
  count: 0,
  last: null as null | { to: string; subject: string; html: string },
}))
vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: {
    sendEmail: (
      _ctx: unknown,
      mail: { to: string; subject: string; html: string },
    ) => {
      sent.count += 1
      sent.last = mail
      return Promise.resolve('provider-id-stub')
    },
  },
}))

const modules = import.meta.glob('./**/*.ts')

describe('notifications.passwordChanged', () => {
  beforeEach(() => {
    sent.count = 0
    sent.last = null
  })

  async function withUser() {
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
    return t
  }

  it('mails the account holder, with a way to review their sessions', async () => {
    const t = await withUser()
    expect(
      await t.mutation(internal.notifications.passwordChanged, {
        betterAuthId: 'ba_1',
      }),
    ).toBe(true)
    expect(sent.last?.to).toBe('r@acme.test')
    expect(sent.last?.html).toContain('/app/me?tab=sessions')

    await t.mutation(internal.notifications.passwordChanged, {
      betterAuthId: 'ba_1',
      added: true,
    })
    expect(sent.last?.subject).toContain('A password was added')
  })

  it('sends nothing for an account that no longer exists', async () => {
    const t = await withUser()
    expect(
      await t.mutation(internal.notifications.passwordChanged, {
        betterAuthId: 'ba_gone',
      }),
    ).toBe(false)
    expect(sent.count).toBe(0)
  })

  // A burst of changes must not become a burst of emails — and since the
  // change itself is already committed, going over budget must not throw.
  it('stops sending past the per-user budget, without failing', async () => {
    const t = await withUser()
    const outcomes: Array<boolean> = []
    for (let i = 0; i < 10; i++) {
      outcomes.push(
        await t.mutation(internal.notifications.passwordChanged, {
          betterAuthId: 'ba_1',
        }),
      )
    }
    expect(outcomes.slice(0, 2)).toEqual([true, true])
    expect(outcomes.slice(2).every((o) => !o)).toBe(true)
    expect(sent.count).toBe(2)
  })
})
