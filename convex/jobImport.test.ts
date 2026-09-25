/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

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

// No network: the page is a long enough ad, and the model is a spy that
// records the prompt it was handed.
vi.mock('./jobImportFetch', async () => {
  const { internalAction } = await import('./_generated/server')
  const { v } = await import('convex/values')
  return {
    fetchJobPage: internalAction({
      args: { url: v.string() },
      handler: () =>
        `<html><body><p>${'Backend engineer, Postgres and queues. '.repeat(30)}</p></body></html>`,
    }),
  }
})

const complete = vi.hoisted(() => vi.fn())
vi.mock('./lib/ai', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  complete,
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

async function seed(t: ReturnType<typeof newTest>): Promise<Id<'projects'>> {
  return await t.run(async (ctx) => {
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
      role: 'owner',
      joinedAt: 0,
    })
    return await ctx.db.insert('projects', {
      orgId,
      slug: 'backend',
      title: 'Backend',
      status: 'draft',
      language: 'en',
      introMode: 'none',
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: userId,
      createdAt: 0,
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
  })
}

/** The system prompt the model was last handed. */
function lastSystemPrompt(): string {
  const [options] = complete.mock.calls.at(-1) as [
    { messages: Array<{ role: string; content: string }> },
  ]
  return options.messages[0].content
}

/**
 * Audit 2026-09-22, h04/h08. The counts reached the prompt unbounded: a
 * negative, huge or NaN count asked the model for a draft the schema then
 * refused, after a paid call.
 */
describe('jobImport.importFromUrl', () => {
  let t: ReturnType<typeof newTest>
  let projectId: Id<'projects'>

  beforeEach(async () => {
    complete.mockReset()
    complete.mockResolvedValue({ value: {} })
    t = newTest()
    projectId = await seed(t)
  })

  const importWith = (counts: {
    questionCount?: number
    criteriaCount?: number
  }) =>
    t
      .withIdentity({ subject: 'ba_recruiter' })
      .action(api.jobImport.importFromUrl, {
        projectId,
        url: 'https://jobs.example.test/ad',
        ...counts,
      })

  it('clamps the counts to what the draft schema accepts', async () => {
    await importWith({ questionCount: 1000, criteriaCount: -4 })
    expect(lastSystemPrompt()).toContain('Exactly 15 questions')
    expect(lastSystemPrompt()).toContain('Exactly 2 weighted evaluation criteria')

    await importWith({ questionCount: 0, criteriaCount: 99 })
    expect(lastSystemPrompt()).toContain('Exactly 3 questions')
    expect(lastSystemPrompt()).toContain('Exactly 8 weighted evaluation criteria')
  })

  it('refuses a count that is not a number, before any call', async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(importWith({ questionCount: bad })).rejects.toThrow(
        /invalid_count/,
      )
      await expect(importWith({ criteriaCount: bad })).rejects.toThrow(
        /invalid_count/,
      )
    }
    expect(complete).not.toHaveBeenCalled()
  })
})
