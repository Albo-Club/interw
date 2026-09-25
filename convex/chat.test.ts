/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { register as registerAgent } from '@convex-dev/agent/test'
import { createThread, listMessages } from '@convex-dev/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, components } from './_generated/api'
import schema from './schema'

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

const modules = import.meta.glob('./**/*.ts')

/**
 * h08. A chat message is stored and re-sent to a paid model on every later
 * turn of its thread, and the rate limiter counts messages, not their size.
 */
describe('chat.sendMessage', () => {
  // The scheduled generation must never run here: it would call the model.
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function setup() {
    const t = convexTest(schema, modules)
    registerRateLimiter(t, 'rateLimiter')
    registerAgent(t, 'agent')
    const seeded = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        betterAuthId: 'ba_recruiter',
        email: 'r@acme.test',
        superAdmin: false,
        createdAt: 0,
      })
      const orgId = await ctx.db.insert('organizations', {
        slug: 'acme',
        name: 'Acme',
        createdBy: userId,
        createdAt: 0,
      })
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role: 'member',
        joinedAt: 0,
      })
      return {
        orgId,
        threadId: await createThread(ctx, components.agent, {
          userId: `${orgId}:${userId}`,
        }),
      }
    })
    const { orgId, threadId } = seeded
    const send = (prompt: string) =>
      t
        .withIdentity({ subject: 'ba_recruiter' })
        .mutation(api.chat.sendMessage, { orgId, threadId, prompt })
    const stored = () =>
      t.run(async (ctx) => {
        const { page } = await listMessages(ctx, components.agent, {
          threadId,
          paginationOpts: { numItems: 10, cursor: null },
        })
        return page.length
      })
    return { send, stored }
  }

  it('refuses a prompt over the cap, and stores nothing', async () => {
    const { send, stored } = await setup()
    await expect(send('a'.repeat(8_001))).rejects.toThrow(/prompt_too_long/)
    expect(await stored()).toBe(0)
  })

  it('accepts a prompt at the cap', async () => {
    const { send, stored } = await setup()
    await send('a'.repeat(8_000))
    expect(await stored()).toBe(1)
  })
})
