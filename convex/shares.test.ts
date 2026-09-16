/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

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
