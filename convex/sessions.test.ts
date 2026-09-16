/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/**
 * Better Auth resolves the caller through its own component, which
 * `convex-test` does not run. Standing in for it here is what lets the real
 * guards (`requireAppUser` → `requireOrgMember` → …) execute against a real
 * identity: the mock answers "who is calling", and every authorisation
 * decision after that is the product's own code.
 */
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
  // The rate limiter is consumed by `invite` before it writes anything, so
  // the component has to be there for the mutation to reach its own logic.
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type Fixture = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  recruiter: Id<'users'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<Fixture> {
  return await t.run(async (ctx) => {
    const recruiter = await ctx.db.insert('users', {
      betterAuthId: 'ba_recruiter',
      email: 'r@acme.test',
      superAdmin: false,
      createdAt: 0,
    })
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: recruiter,
      createdAt: 0,
    })
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId: recruiter,
      role: 'owner',
      joinedAt: 0,
    })
    const projectId = await ctx.db.insert('projects', {
      orgId,
      slug: 'backend',
      title: 'Backend',
      status: 'active',
      language: 'fr',
      introMode: 'none',
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: recruiter,
      createdAt: 0,
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    return { orgId, projectId, recruiter }
  })
}

const asRecruiter = (t: ReturnType<typeof newTest>) =>
  t.withIdentity({ subject: 'ba_recruiter' })

/**
 * Retention only covers what it can name. An interview that is never finished
 * — the majority in a hiring funnel — used to get no clock at all, so its CV,
 * address and part-recorded answers were kept without limit.
 */
describe('the retention clock', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  it('starts at the invitation, not at the interview', async () => {
    const { results } = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })

    const session = await t.run(async (ctx) =>
      ctx.db.get('sessions', results[0].sessionId),
    )
    expect(session?.purgeAfter).toEqual(expect.any(Number))
    expect(session?.purgeAfter).toBe(
      session!.invitedAt + INVITED_RETENTION_MS_EXPECTED,
    )
  })

  it('is pushed out when the candidate finishes', async () => {
    const { results } = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    const sessionId = results[0].sessionId
    const invited = await t.run(async (ctx) => ctx.db.get('sessions', sessionId))

    await t.mutation(api.interview.finish, { token: invited!.accessToken })

    const finished = await t.run(async (ctx) =>
      ctx.db.get('sessions', sessionId),
    )
    expect(finished!.purgeAfter).toBeGreaterThan(invited!.purgeAfter!)
  })

  it('makes an abandoned session reachable by the purge', async () => {
    const { results } = await asRecruiter(t).mutation(api.sessions.invite, {
      projectId: f.projectId,
      candidates: [{ name: 'Alex Martin', email: 'alex@example.test' }],
    })
    const sessionId = results[0].sessionId
    const session = await t.run(async (ctx) => ctx.db.get('sessions', sessionId))

    const due = await t.query(internal.purge.sessionsDueForPurge, {
      before: session!.purgeAfter! + 1,
      limit: 25,
    })
    expect(due).toEqual([sessionId])
  })
})

/** Six months from the invitation. Mirrors INVITED_RETENTION_MS. */
const INVITED_RETENTION_MS_EXPECTED = 183 * 24 * 60 * 60 * 1000
