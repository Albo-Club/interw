/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type TestConvex = ReturnType<typeof newTest>
type Who = 'creator' | 'teammate' | 'outsider' | 'admin'

type Seed = {
  orgId: Id<'organizations'>
  sessionId: Id<'sessions'>
  users: Record<Who, Id<'users'>>
}

/**
 * One role, created by a plain member. Its team is the creator plus one
 * teammate; the outsider is in the organisation but not on the team; the
 * admin sees everything without being on it.
 */
async function seed(t: TestConvex): Promise<Seed> {
  return await t.run(async (ctx) => {
    const users = {} as Record<Who, Id<'users'>>
    for (const who of ['creator', 'teammate', 'outsider', 'admin'] as const) {
      users[who] = await ctx.db.insert('users', {
        betterAuthId: `ba_${who}`,
        email: `${who}@acme.test`,
        name: who,
        superAdmin: false,
        createdAt: 0,
      })
    }
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: users.admin,
      createdAt: 0,
    })
    for (const who of ['creator', 'teammate', 'outsider', 'admin'] as const) {
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId: users[who],
        role: who === 'admin' ? 'admin' : 'member',
        joinedAt: 0,
      })
    }
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
      createdBy: users.creator,
      createdAt: 0,
      restricted: true,
      sessionCount: 1,
      completedSessionCount: 1,
    })
    await ctx.db.insert('projectShares', {
      orgId,
      projectId,
      userId: users.teammate,
      grantedBy: users.creator,
      grantedAt: 0,
    })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: 'p'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: users.creator,
      invitedAt: 0,
      completedAt: 1,
    })
    return { orgId, sessionId, users }
  })
}

const as = (t: TestConvex, who: Who) =>
  t.withIdentity({ subject: `ba_${who}` })

/**
 * Audit 2026-09-15, recruiter M12. A failed analysis showed the recruiter the
 * step that failed and then left them without recourse.
 */
describe('relaunching a report from the candidate page', () => {
  let t: TestConvex
  let s: Seed

  beforeEach(async () => {
    // Keep the scheduled `onSessionCompleted` from running: what is under
    // test is who may ask and what gets written, not the pipeline itself.
    vi.useFakeTimers()
    t = newTest()
    s = await seed(t)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const relaunches = () =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('jobLog')
          .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
          .collect()
      ).filter((row) => row.step === 'relaunch'),
    )

  it('is open to the creator of the role, and logged with who asked', async () => {
    await as(t, 'creator').mutation(api.reports.relaunch, {
      sessionId: s.sessionId,
    })
    const rows = await relaunches()
    expect(rows).toHaveLength(1)
    expect(rows[0].actorId).toBe(s.users.creator)
  })

  it('is open to an org admin who is not on the team', async () => {
    await as(t, 'admin').mutation(api.reports.relaunch, {
      sessionId: s.sessionId,
    })
    expect(await relaunches()).toHaveLength(1)
  })

  it('is refused to a teammate who is neither creator nor admin', async () => {
    await expect(
      as(t, 'teammate').mutation(api.reports.relaunch, {
        sessionId: s.sessionId,
      }),
    ).rejects.toThrow(/insufficient_role/)
    expect(await relaunches()).toHaveLength(0)
  })

  it('does not reveal the role to a member outside its team', async () => {
    await expect(
      as(t, 'outsider').mutation(api.reports.relaunch, {
        sessionId: s.sessionId,
      }),
    ).rejects.toThrow(/not_found/)
  })

  it('is rate-limited per person', async () => {
    const relaunch = () =>
      as(t, 'creator').mutation(api.reports.relaunch, {
        sessionId: s.sessionId,
      })
    for (let i = 0; i < 3; i++) await relaunch()
    await expect(relaunch()).rejects.toThrow(/rate_limited/)
    expect(await relaunches()).toHaveLength(3)
  })

  it('is refused once a report exists', async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert('reports', {
        orgId: s.orgId,
        sessionId: s.sessionId,
        overallScore: 70,
        recommendation: 'yes',
        executiveSummary: 'Solid.',
        criteriaScores: [],
        strengths: [],
        concerns: [],
        model: 'test',
        generatedAt: 1,
      })
    })
    await expect(
      as(t, 'creator').mutation(api.reports.relaunch, {
        sessionId: s.sessionId,
      }),
    ).rejects.toThrow(/report_exists/)
  })
})

/**
 * Audit 2026-09-15, recruiter E9. The delete button was shown to every member
 * who could see the role, and the server refused most of them.
 */
describe('what the candidate page lets the caller manage', () => {
  it('is true for the creator and an admin, false for a teammate', async () => {
    const t = newTest()
    const s = await seed(t)
    const canManage = async (who: Who) =>
      (
        await as(t, who).query(api.reports.forSession, {
          sessionId: s.sessionId,
        })
      ).canManage
    expect(await canManage('creator')).toBe(true)
    expect(await canManage('admin')).toBe(true)
    expect(await canManage('teammate')).toBe(false)
  })
})

/**
 * Product §3.6. `sessions` kept only the current decision, so who shortlisted
 * a candidate and who rejected them afterwards could not be told.
 */
describe('decision history', () => {
  it('records every change, with who made it, newest first', async () => {
    const t = newTest()
    const s = await seed(t)
    const decide = (who: Who, decision: 'shortlisted' | 'rejected' | null) =>
      as(t, who).mutation(api.reports.setDecision, {
        sessionId: s.sessionId,
        decision,
      })

    await decide('creator', 'shortlisted')
    // The same decision again changes nothing, and records nothing.
    await decide('teammate', 'shortlisted')
    await decide('teammate', 'rejected')
    await decide('creator', null)

    const view = await as(t, 'creator').query(api.reports.forSession, {
      sessionId: s.sessionId,
    })
    expect(
      view.decisionHistory.map((event) => [event.decision, event.by.name]),
    ).toEqual([
      [null, 'creator'],
      ['rejected', 'teammate'],
      ['shortlisted', 'creator'],
    ])
    // No address in the rows themselves: an id, resolved at read time.
    const rows = await t.run(async (ctx) =>
      ctx.db.query('decisionEvents').collect(),
    )
    expect(JSON.stringify(rows)).not.toContain('@acme.test')
  })
})

/**
 * Carried over from audit T07: the documents downloaded from the candidate
 * page were named in French ("Lettre - …") whatever the recruiter's language,
 * and without their extension.
 */
describe('document download names', () => {
  beforeEach(() => {
    vi.stubEnv('OBJECT_STORE_ENDPOINT', 'https://s3.example.test')
    vi.stubEnv('OBJECT_STORE_REGION', 'fr-par')
    vi.stubEnv('OBJECT_STORE_BUCKET', 'media')
    vi.stubEnv('OBJECT_STORE_ACCESS_KEY_ID', 'test-access-key')
    vi.stubEnv('OBJECT_STORE_SECRET_ACCESS_KEY', 'test-secret-key')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const disposition = (url: string | null) =>
    url && new URL(url).searchParams.get('response-content-disposition')

  it("names each document in the recruiter's language, with its extension", async () => {
    const t = newTest()
    const s = await seed(t)
    await t.run((ctx) =>
      ctx.db.patch('sessions', s.sessionId, {
        cvKey: `orgs/${s.orgId}/sessions/${s.sessionId}/cv.docx`,
        coverLetterKey: `orgs/${s.orgId}/sessions/${s.sessionId}/cover.pdf`,
      }),
    )
    const fetch = (language: 'en' | 'fr') =>
      as(t, 'creator').action(api.reports.sessionMediaUrls, {
        sessionId: s.sessionId,
        language,
      })

    const en = await fetch('en')
    expect(disposition(en.coverLetter)).toBe(
      'attachment; filename="Cover letter - Alex Martin.pdf"',
    )
    expect(disposition(en.cv)).toBe('attachment; filename="CV - Alex Martin.docx"')

    const fr = await fetch('fr')
    expect(disposition(fr.coverLetter)).toBe(
      'attachment; filename="Lettre de motivation - Alex Martin.pdf"',
    )
  })
})
