/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { register as registerAgent } from '@convex-dev/agent/test'
import { createThread, listMessages } from '@convex-dev/agent'
import { describe, expect, it, vi } from 'vitest'

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

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  registerAgent(t, 'agent')
  return t
}

/**
 * Audit 2026-09-22, h08. The prompt was stored and sent to the model whatever
 * its length; only the auto-title was cut.
 */
describe('chat.sendMessage', () => {
  it('refuses an oversized prompt before storing anything', async () => {
    const t = newTest()
    const { orgId, threadId } = await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', {
        betterAuthId: 'ba_recruiter',
        email: 'r@acme.test',
        superAdmin: false,
        createdAt: 0,
      })
      const org = await ctx.db.insert('organizations', {
        slug: 'acme',
        name: 'Acme',
        createdBy: userId,
        createdAt: 0,
      })
      await ctx.db.insert('organizationMembers', {
        orgId: org,
        userId,
        role: 'owner',
        joinedAt: 0,
      })
      const thread = await createThread(ctx, components.agent, {
        userId: `${org}:${userId}`,
      })
      return { orgId: org, threadId: thread }
    })

    await expect(
      t.withIdentity({ subject: 'ba_recruiter' }).mutation(api.chat.sendMessage, {
        orgId,
        threadId,
        prompt: 'x'.repeat(8_001),
      }),
    ).rejects.toThrow(/prompt_too_long/)

    const messages = await t.run(async (ctx) =>
      listMessages(ctx, components.agent, {
        threadId,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    )
    expect(messages.page).toEqual([])
  })
})
