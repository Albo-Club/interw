/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from './_generated/api'
import { rateLimiter } from './rateLimiters'
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

const modules = import.meta.glob('./**/*.ts')
const NOW = 1_900_000_000_000
const DAY = 24 * 60 * 60 * 1000

function newTest() {
  return convexTest(schema, modules)
}

type Seed = {
  shareId: Id<'reportShares'>
  token: string
}

async function seed(t: ReturnType<typeof newTest>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_1',
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
    const projectId = await ctx.db.insert('projects', {
      orgId,
      slug: 'backend',
      title: 'INTERNAL Backend',
      jobTitle: 'Backend Engineer',
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
      accessToken: 'z'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      candidatePhone: '+33600000000',
      candidateLinkedin: 'https://linkedin.test/in/alex',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: userId,
      invitedAt: 0,
      completedAt: NOW - DAY,
      recruiterNote: 'CONFIDENTIAL working note',
      recruiterDecision: 'shortlisted',
      cvKey: 'orgs/o/sessions/s/cv.pdf',
    })
    const reportId = await ctx.db.insert('reports', {
      orgId,
      sessionId,
      overallScore: 72,
      recommendation: 'yes',
      executiveSummary: 'Strong on the technical side.',
      criteriaScores: [],
      strengths: ['Led a migration'],
      concerns: [],
      model: 'test',
      generatedAt: NOW - DAY,
    })
    const token = 's'.repeat(43)
    const shareId = await ctx.db.insert('reportShares', {
      orgId,
      reportId,
      token,
      createdBy: userId,
      viewCount: 0,
      createdAt: NOW - DAY,
    })
    return { shareId, token }
  })
}

describe('shares.view', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('serves the report for a live link', async () => {
    const result = await t.query(api.shares.view, { token: s.token, now: NOW })
    expect(result.state).toBe('active')
    expect(result.report?.candidateName).toBe('Alex Martin')
    expect(result.report?.overallScore).toBe(72)
  })

  // A share link is a grant to one assessment, not to a person's file.
  it('withholds the recruiter note, contact details and documents', async () => {
    const result = await t.query(api.shares.view, { token: s.token, now: NOW })
    const serialised = JSON.stringify(result)
    expect(serialised).not.toContain('CONFIDENTIAL')
    expect(serialised).not.toContain('alex@example.test')
    expect(serialised).not.toContain('+33600000000')
    expect(serialised).not.toContain('linkedin.test')
    expect(serialised).not.toContain('cv.pdf')
    expect(serialised).not.toContain('INTERNAL')
  })

  it('stops serving once revoked', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('reportShares', s.shareId, { revokedAt: NOW - 1 })
    })
    const result = await t.query(api.shares.view, { token: s.token, now: NOW })
    expect(result).toEqual({ state: 'revoked', report: null })
  })

  it('stops serving once expired', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('reportShares', s.shareId, { expiresAt: NOW - 1 })
    })
    const result = await t.query(api.shares.view, { token: s.token, now: NOW })
    expect(result).toEqual({ state: 'expired', report: null })
  })

  it('still serves right up to the expiry instant', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('reportShares', s.shareId, { expiresAt: NOW })
    })
    const result = await t.query(api.shares.view, { token: s.token, now: NOW })
    expect(result.state).toBe('active')
  })

  /**
   * `now` arrives from whoever holds the link. Before this was bounded,
   * `view({ token, now: 0 })` answered `active` on a link that had expired
   * weeks earlier, and `sharedMediaUrls` then signed an hour of playback on
   * the candidate's video. An expiry that the holder can argue with is not an
   * expiry.
   */
  it('stays expired however far into the past the caller claims to be', async () => {
    await t.run(async (ctx) => {
      // Expired against the real server clock, not against the fixture's.
      await ctx.db.patch('reportShares', s.shareId, { expiresAt: 1_000 })
    })

    for (const now of [0, -1, Number.MIN_SAFE_INTEGER]) {
      const result = await t.query(api.shares.view, { token: s.token, now })
      expect(result).toEqual({ state: 'expired', report: null })
    }
  })

  it('mints no playback URL for an expired link, whatever `now` says', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('reportShares', s.shareId, { expiresAt: 1_000 })
    })

    const urls = await t.action(api.shares.sharedMediaUrls, {
      token: s.token,
      now: 0,
    })
    expect(urls).toEqual([])
  })

  it('still lets an honest clock drive the view', async () => {
    const result = await t.query(api.shares.view, { token: s.token, now: NOW })
    expect(result.state).toBe('active')
  })

  it('reports unknown and malformed tokens the same way', async () => {
    for (const token of ['x'.repeat(43), '', 'nope', '../../reports']) {
      const result = await t.query(api.shares.view, { token, now: NOW })
      expect(result).toEqual({ state: 'not_found', report: null })
    }
  })
})

describe('shares.recordView', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    registerRateLimiter(t, 'rateLimiter')
    s = await seed(t)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Fingerprint: convex/shares.ts:recordView:limiter-key-before-token-check
  // The limiter ran on the raw argument before the token was resolved, so an
  // anonymous caller chose the keys written to the limiter's store. An
  // unresolved token now fails like every other one in this file — nothing
  // counted, nothing written, nothing thrown — before the limiter is reached.
  it('never reaches the limiter with a token that does not resolve', async () => {
    const limit = vi.spyOn(rateLimiter, 'limit')
    const revoked = 'r'.repeat(43)
    await t.run(async (ctx) => {
      const share = await ctx.db.get('reportShares', s.shareId)
      await ctx.db.insert('reportShares', {
        orgId: share!.orgId,
        reportId: share!.reportId,
        token: revoked,
        createdBy: share!.createdBy,
        viewCount: 0,
        createdAt: NOW - DAY,
        revokedAt: NOW - DAY,
      })
    })

    for (const token of ['x'.repeat(43), '', 'nope', '../../reports', revoked]) {
      // Well past the bucket's capacity: a limiter keyed on the argument
      // would start throwing here.
      for (let i = 0; i < 40; i++) {
        expect(await t.mutation(api.shares.recordView, { token })).toBeNull()
      }
    }
    expect(limit).not.toHaveBeenCalled()
  })

  it('still counts and rate-limits views of a live link', async () => {
    const limit = vi.spyOn(rateLimiter, 'limit')
    let limited = 0
    for (let i = 0; i < 35; i++) {
      try {
        await t.mutation(api.shares.recordView, { token: s.token })
      } catch (error) {
        expect(error).toBeInstanceOf(ConvexError)
        expect((error as ConvexError<{ code: string }>).data).toMatchObject({
          code: 'rate_limited',
          limit: 'shareView',
        })
        limited += 1
      }
    }
    expect(limited).toBe(5)
    const share = await t.run((ctx) => ctx.db.get('reportShares', s.shareId))
    expect(share?.viewCount).toBe(30)
    expect(share?.lastViewedAt).toBeTypeOf('number')
    expect(limit).toHaveBeenCalledTimes(35)
  })
})

/**
 * Audit 2026-09-22, h03. NaN, Infinity or a huge count wrote an expiry that
 * never came; a negative one wrote a link dead at creation, still listed.
 */
describe('shares.create', () => {
  let t: ReturnType<typeof newTest>
  let sessionId: Id<'sessions'>

  beforeEach(async () => {
    vi.stubEnv('SITE_URL', 'https://interw.test')
    t = newTest()
    await seed(t)
    sessionId = await t.run(async (ctx) => {
      const session = (await ctx.db.query('sessions').first())!
      const user = (await ctx.db.query('users').first())!
      await ctx.db.insert('organizationMembers', {
        orgId: session.orgId,
        userId: user._id,
        role: 'owner',
        joinedAt: 0,
      })
      return session._id
    })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const create = (expiresInDays: number | null) =>
    t
      .withIdentity({ subject: 'ba_1' })
      .mutation(api.shares.create, { sessionId, expiresInDays })

  it('accepts no expiry, or a whole number of days up to a year', async () => {
    for (const days of [null, 1, 30, 365]) {
      await expect(create(days)).resolves.toEqual({ url: expect.any(String) })
    }
  })

  it('refuses any other expiry, and writes nothing', async () => {
    for (const days of [0, -1, 1.5, 366, 1e12, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(create(days)).rejects.toThrow(/invalid_expiry/)
    }
    const shares = await t.run(async (ctx) =>
      ctx.db.query('reportShares').collect(),
    )
    // Only the one the seed wrote.
    expect(shares).toHaveLength(1)
  })
})
