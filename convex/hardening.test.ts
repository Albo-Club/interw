/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
import { draftCount } from './jobImport'
import { rateLimiter } from './rateLimiters'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/**
 * Backend hardening from §5 of the 2026-09-22 security audit (task T10) that
 * needs a signed-in recruiter. The token surfaces are tested next to their
 * modules: candidate.test.ts, documentGate.test.ts, interview.test.ts,
 * shares.test.ts.
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
const DAY = 24 * 60 * 60 * 1000

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type Fixture = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  sessionId: Id<'sessions'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<Fixture> {
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
      createdBy: userId,
      createdAt: 0,
      restricted: false,
      sessionCount: 1,
      completedSessionCount: 1,
    })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: 'd'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: userId,
      // Well outside the dashboard's 30-day window, by the server's clock.
      invitedAt: Date.now() - 60 * DAY,
      completedAt: 1,
    })
    await ctx.db.insert('reports', {
      orgId,
      sessionId,
      overallScore: 72,
      recommendation: 'yes',
      executiveSummary: 'Strong on the technical side.',
      criteriaScores: [],
      strengths: [],
      concerns: [],
      model: 'test',
      generatedAt: 1,
    })
    return { orgId, projectId, sessionId }
  })
}

const asRecruiter = (t: ReturnType<typeof newTest>) =>
  t.withIdentity({ subject: 'ba_recruiter' })

/** h04. The caller's `now` placed the dashboard's activity window. */
describe('dashboard.overview', () => {
  it('does not let the caller move its window into the past', async () => {
    const t = newTest()
    const f = await seed(t)
    for (const now of [0, -1, Date.now()]) {
      const overview = await asRecruiter(t).query(api.dashboard.overview, {
        orgId: f.orgId,
        now,
      })
      expect(overview.invitedInWindow).toBe(0)
    }
  })
})

/**
 * h03. NaN, Infinity and huge values stored an expiry that never arrives —
 * shown as "expires on Invalid Date" — and a negative one a link dead at
 * creation yet still listed.
 */
describe('shares.create', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    vi.stubEnv('SITE_URL', 'https://interw.test')
    t = newTest()
    f = await seed(t)
  })

  it('refuses an expiry outside 1..365 whole days', async () => {
    for (const expiresInDays of [0, -1, 1.5, 366, 1e12, NaN, Infinity]) {
      await expect(
        asRecruiter(t).mutation(api.shares.create, {
          sessionId: f.sessionId,
          expiresInDays,
        }),
      ).rejects.toThrow('invalid_expiry')
    }
  })

  it('still issues the lengths the dialog offers, and no expiry', async () => {
    for (const expiresInDays of [7, 30, 365, null]) {
      const { url } = await asRecruiter(t).mutation(api.shares.create, {
        sessionId: f.sessionId,
        expiresInDays,
      })
      expect(url).toMatch(/^https:\/\/interw\.test\/r\//)
    }
  })
})

/** h04. Any registered user could mint storage upload URLs without limit. */
describe('files.generateUploadUrl', () => {
  it('is rate limited per user', async () => {
    const t = newTest()
    await seed(t)
    let limited = 0
    for (let i = 0; i < 12; i++) {
      try {
        await asRecruiter(t).mutation(api.files.generateUploadUrl, {})
      } catch (error) {
        expect(String(error)).toContain('rate_limited')
        limited += 1
      }
    }
    expect(limited).toBe(2)
  })
})

/**
 * h04/h08/h12. The counts reached the prompt unbounded, so any out-of-range
 * value guaranteed a billed completion that then failed `draftSchema`.
 */
describe('job import draft counts', () => {
  it('clamps to the bounds the draft schema enforces', () => {
    const range = { min: 3, max: 15 }
    expect(draftCount(undefined, 6, range)).toBe(6)
    expect(draftCount(NaN, 6, range)).toBe(6)
    expect(draftCount(Infinity, 6, range)).toBe(6)
    expect(draftCount(-4, 6, range)).toBe(3)
    expect(draftCount(1e9, 6, range)).toBe(15)
    expect(draftCount(7.4, 6, range)).toBe(7)
  })
})

/**
 * h12. `candidateRead` was declared and never consumed: the limiter table
 * described a protection nothing enforced. Every bucket declared must be
 * spent somewhere.
 */
describe('the rate limiter table', () => {
  const sources = import.meta.glob<string>(['./**/*.ts', '!./**/*.test.ts'], {
    query: '?raw',
    import: 'default',
    eager: true,
  })

  it('declares only buckets some function consumes', () => {
    const code = Object.entries(sources)
      .filter(([path]) => path !== './rateLimiters.ts')
      .map(([, text]) => text)
      .join('\n')
    const declared = Object.keys(
      (rateLimiter as unknown as { limits: Record<string, unknown> }).limits,
    )
    expect(declared.length).toBeGreaterThan(0)
    const unused = declared.filter(
      (name) => !code.includes(`'${name}'`),
    )
    expect(unused).toEqual([])
  })
})
