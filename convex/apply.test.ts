/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
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
  // `apply.start` consumes a rate-limit token before it writes.
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

/** Create the role's link and read its token back. */
async function applyToken(t: ReturnType<typeof newTest>, f: Fixture) {
  await asRecruiter(t).mutation(api.projects.enableApplyLink, {
    projectId: f.projectId,
  })
  const project = await t.run(async (ctx) =>
    ctx.db.get('projects', f.projectId),
  )
  return project!.applyToken!
}

const candidate = { name: 'Alex Martin', email: 'Alex@Example.test' }

describe("a role's public link", () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    vi.stubEnv('SITE_URL', 'http://localhost:3000')
    t = newTest()
    f = await seed(t)
  })

  it('is minted once and then stays the same', async () => {
    const first = await applyToken(t, f)
    const second = await applyToken(t, f)
    expect(second).toBe(first)
    const page = await asRecruiter(t).query(api.projects.getBySlug, {
      orgId: f.orgId,
      slug: 'backend',
    })
    expect(page.project.applyUrl).toBe(`http://localhost:3000/apply/${first}`)
  })

  it('can only be minted by someone on the role', async () => {
    await expect(
      t.mutation(api.projects.enableApplyLink, { projectId: f.projectId }),
    ).rejects.toThrow()
  })

  it('opens a session of its own that the candidate pages resolve', async () => {
    const token = await applyToken(t, f)
    const { sessionToken } = await t.mutation(api.apply.start, {
      token,
      ...candidate,
    })

    const landing = await t.query(api.candidate.landing, {
      token: sessionToken,
      now: Date.now(),
    })
    expect(landing.session.candidateName).toBe('Alex Martin')
    expect(landing.session.candidateEmail).toBe('alex@example.test')
    expect(landing.gate.state).toBe('ready')

    const project = await t.run(async (ctx) =>
      ctx.db.get('projects', f.projectId),
    )
    expect(project!.sessionCount).toBe(1)
    const session = await t.run(async (ctx) =>
      ctx.db
        .query('sessions')
        .withIndex('by_token', (q) => q.eq('accessToken', sessionToken))
        .unique(),
    )
    expect(session!.invitedBy).toBeUndefined()
    expect(session!.purgeAfter).toEqual(expect.any(Number))
  })

  // Returning the existing session for an address would hand it to anyone
  // who knows that address.
  it('never hands back an existing session for the same address', async () => {
    const token = await applyToken(t, f)
    const a = await t.mutation(api.apply.start, { token, ...candidate })
    const b = await t.mutation(api.apply.start, { token, ...candidate })
    expect(b.sessionToken).not.toBe(a.sessionToken)
  })

  it('sends no email on submission', async () => {
    const token = await applyToken(t, f)
    await t.mutation(api.apply.start, { token, ...candidate })
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query('_scheduled_functions').collect(),
    )
    expect(scheduled).toHaveLength(0)
  })

  it('fails the same way for every token that does not resolve', async () => {
    await applyToken(t, f)
    for (const token of ['x', 'A'.repeat(43)]) {
      await expect(
        t.query(api.apply.landing, { token, now: Date.now() }),
      ).rejects.toThrow(/not_found/)
      await expect(
        t.mutation(api.apply.start, { token, ...candidate }),
      ).rejects.toThrow(/not_found/)
    }
  })

  it('reads closed, and writes nothing, once the role is not live', async () => {
    const token = await applyToken(t, f)
    await t.run(async (ctx) =>
      ctx.db.patch('projects', f.projectId, { status: 'archived' }),
    )
    const page = await t.query(api.apply.landing, { token, now: Date.now() })
    expect(page.state).toBe('closed')
    await expect(
      t.mutation(api.apply.start, { token, ...candidate }),
    ).rejects.toThrow(/closed/)

    await t.run(async (ctx) =>
      ctx.db.patch('projects', f.projectId, {
        status: 'active',
        expiresAt: Date.now() - 5 * 60_000,
      }),
    )
    // A client clock cannot reopen it (see convex/lib/clock.ts).
    const late = await t.query(api.apply.landing, { token, now: 0 })
    expect(late.state).toBe('expired')
    await expect(
      t.mutation(api.apply.start, { token, ...candidate }),
    ).rejects.toThrow(/expired/)

    const sessions = await t.run(async (ctx) =>
      ctx.db.query('sessions').collect(),
    )
    expect(sessions).toHaveLength(0)
  })

  it('rejects an address that is not one', async () => {
    const token = await applyToken(t, f)
    await expect(
      t.mutation(api.apply.start, { token, name: 'Alex', email: 'nope' }),
    ).rejects.toThrow(/invalid_email/)
  })
})
