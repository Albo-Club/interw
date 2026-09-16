/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/**
 * Better Auth resolves the caller through its own component, which
 * `convex-test` does not run. This stands in for that one step — "who is
 * calling" — and nothing else: every authorisation decision below is the
 * product's own code, executed.
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

vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: { sendEmail: () => Promise.resolve('provider-id-stub') },
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

/**
 * Two organisations, and inside the first one every role that matters:
 *
 *   acmeOwner    owner of Acme
 *   acmeMember   plain member of Acme, not named on the restricted role
 *   acmeShared   plain member of Acme, named on the restricted role
 *   rivalOwner   owner of a different organisation entirely
 *   superAdmin   deployment-wide
 */
type World = {
  acmeOrgId: Id<'organizations'>
  openProjectId: Id<'projects'>
  sessionId: Id<'sessions'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<World> {
  return await t.run(async (ctx) => {
    const users: Record<string, Id<'users'>> = {}
    for (const [key, superAdmin] of [
      ['acmeOwner', false],
      ['acmeMember', false],
      ['acmeShared', false],
      ['rivalOwner', false],
      ['superAdmin', true],
    ] as Array<[string, boolean]>) {
      users[key] = await ctx.db.insert('users', {
        betterAuthId: `ba_${key}`,
        email: `${key}@example.test`,
        superAdmin,
        createdAt: 0,
      })
    }

    const acmeOrgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: users.acmeOwner,
      createdAt: 0,
    })
    const rivalOrgId = await ctx.db.insert('organizations', {
      slug: 'rival',
      name: 'Rival',
      createdBy: users.rivalOwner,
      createdAt: 0,
    })
    for (const [userId, orgId, role] of [
      [users.acmeOwner, acmeOrgId, 'owner'],
      [users.acmeMember, acmeOrgId, 'member'],
      [users.acmeShared, acmeOrgId, 'member'],
      [users.rivalOwner, rivalOrgId, 'owner'],
    ] as Array<[Id<'users'>, Id<'organizations'>, 'owner' | 'member']>) {
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role,
        joinedAt: 0,
      })
    }

    const baseProject = {
      orgId: acmeOrgId,
      status: 'active' as const,
      language: 'fr' as const,
      introMode: 'none' as const,
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: users.acmeOwner,
      createdAt: 0,
      completedSessionCount: 1,
    }
    const openProjectId = await ctx.db.insert('projects', {
      ...baseProject,
      slug: 'backend',
      title: 'Backend',
      restricted: false,
      sessionCount: 1,
    })
    const restrictedProjectId = await ctx.db.insert('projects', {
      ...baseProject,
      slug: 'chief-of-staff',
      title: 'Chief of Staff',
      restricted: true,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    await ctx.db.insert('projectShares', {
      orgId: acmeOrgId,
      projectId: restrictedProjectId,
      userId: users.acmeShared,
      grantedBy: users.acmeOwner,
      grantedAt: 0,
    })

    const sessionId = await ctx.db.insert('sessions', {
      orgId: acmeOrgId,
      projectId: openProjectId,
      accessToken: 'g'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: users.acmeOwner,
      invitedAt: 0,
      completedAt: 1,
    })
    await ctx.db.insert('reports', {
      orgId: acmeOrgId,
      sessionId,
      overallScore: 71,
      recommendation: 'yes',
      executiveSummary: 'Solid.',
      criteriaScores: [],
      strengths: ['Something'],
      concerns: [],
      model: 'test',
      generatedAt: 0,
    })

    return { acmeOrgId, openProjectId, sessionId }
  })
}

const as = (t: ReturnType<typeof newTest>, who: string) =>
  t.withIdentity({ subject: `ba_${who}` })

/**
 * The guards were read function by function and found correct. Nothing
 * executed them: `requireOrgMember`, `requireOrgRole`, `requireSuperAdmin` and
 * the `requireProject*` family appeared in no test at all, and the script that
 * "verified" them is a search over source text that cannot tie an argument to
 * a guard. These tests make the refusal a property rather than a reading.
 */
describe('the organisation boundary', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('refuses a stranger the role itself', async () => {
    await expect(
      as(t, 'rivalOwner').query(api.projects.getBySlug, {
        orgId: w.acmeOrgId,
        slug: 'backend',
      }),
    ).rejects.toThrow()
  })

  it('refuses a stranger the right to invite onto it', async () => {
    await expect(
      as(t, 'rivalOwner').mutation(api.sessions.invite, {
        projectId: w.openProjectId,
        candidates: [{ name: 'Someone', email: 'someone@example.test' }],
      }),
    ).rejects.toThrow()
  })

  it("refuses a stranger a candidate's report", async () => {
    await expect(
      as(t, 'rivalOwner').query(api.reports.forSession, {
        sessionId: w.sessionId,
      }),
    ).rejects.toThrow()
  })

  it('refuses a stranger the right to share that report outside', async () => {
    await expect(
      as(t, 'rivalOwner').mutation(api.shares.create, {
        sessionId: w.sessionId,
        expiresInDays: 7,
      }),
    ).rejects.toThrow()
  })

  it('refuses a stranger the right to decide on a candidate', async () => {
    await expect(
      as(t, 'rivalOwner').mutation(api.reports.setDecision, {
        sessionId: w.sessionId,
        decision: 'hired',
      }),
    ).rejects.toThrow()
  })

  it('refuses an unauthenticated caller the same things', async () => {
    await expect(
      t.query(api.projects.getBySlug, { orgId: w.acmeOrgId, slug: 'backend' }),
    ).rejects.toThrow()
    await expect(
      t.query(api.reports.forSession, { sessionId: w.sessionId }),
    ).rejects.toThrow()
  })

  it('lets the owner through all of it', async () => {
    const detail = await as(t, 'acmeOwner').query(api.projects.getBySlug, {
      orgId: w.acmeOrgId,
      slug: 'backend',
    })
    expect(detail.project.slug).toBe('backend')
    await as(t, 'acmeOwner').mutation(api.reports.setDecision, {
      sessionId: w.sessionId,
      decision: 'shortlisted',
    })
  })
})

/**
 * A restricted role is invisible, not forbidden: a recruiter should not learn
 * that a confidential search exists, so the refusal is `not_found`.
 */
describe('project visibility inside an organisation', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('hides a restricted role from a member who is not named on it', async () => {
    await expect(
      as(t, 'acmeMember').query(api.projects.getBySlug, {
        orgId: w.acmeOrgId,
        slug: 'chief-of-staff',
      }),
    ).rejects.toThrow()

    const list = await as(t, 'acmeMember').query(api.projects.list, {
      orgId: w.acmeOrgId,
    })
    expect(list.map((p) => p.slug)).toEqual(['backend'])
  })

  it('shows it to the member who is named on it', async () => {
    const detail = await as(t, 'acmeShared').query(api.projects.getBySlug, {
      orgId: w.acmeOrgId,
      slug: 'chief-of-staff',
    })
    expect(detail.project.slug).toBe('chief-of-staff')
  })
})

/**
 * Recruiter E9: the two most destructive actions in the product were the least
 * protected. Archiving closes the link of every candidate mid-interview at
 * once; erasing a candidate destroys their recordings, their CV and their
 * assessment. Both needed only "can see the role", while deleting an EMPTY
 * role needed owner or admin.
 */
describe('destructive actions need owner or admin', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('refuses a plain member the right to archive a live role', async () => {
    await expect(
      as(t, 'acmeMember').mutation(api.projects.archive, {
        projectId: w.openProjectId,
      }),
    ).rejects.toThrow()

    const project = await t.run(async (ctx) =>
      ctx.db.get('projects', w.openProjectId),
    )
    expect(project?.status).toBe('active')
  })

  /**
   * Asserted on `assertCanDelete` rather than on the action that calls it.
   * `deleteCandidateData` reaches object storage on its second step, so in a
   * test it throws whatever the guard decides — which would make this pass for
   * the wrong reason, and did.
   */
  it("refuses a plain member the right to erase a candidate's data", async () => {
    await expect(
      as(t, 'acmeMember').query(internal.sessions.assertCanDelete, {
        sessionId: w.sessionId,
      }),
    ).rejects.toThrow()
  })

  it('lets the owner past that same guard', async () => {
    await as(t, 'acmeOwner').query(internal.sessions.assertCanDelete, {
      sessionId: w.sessionId,
    })
  })

  it('lets the owner archive', async () => {
    await as(t, 'acmeOwner').mutation(api.projects.archive, {
      projectId: w.openProjectId,
    })
    const project = await t.run(async (ctx) =>
      ctx.db.get('projects', w.openProjectId),
    )
    expect(project?.status).toBe('archived')
  })
})

describe('the super-admin boundary', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(async () => {
    t = newTest()
    await seed(t)
  })

  it('refuses an organisation owner the deployment-wide view', async () => {
    await expect(
      as(t, 'acmeOwner').query(api.admin.overview, {}),
    ).rejects.toThrow()
  })

  it('lets the super-admin have it', async () => {
    const overview = await as(t, 'superAdmin').query(api.admin.overview, {})
    expect(overview.orgCount).toBe(2)
  })

  /**
   * Being a super-admin is deployment-wide, and deliberately does NOT imply
   * membership of an organisation: the two boundaries are separate, and a
   * super-admin who has not been added to Acme has no business reading Acme's
   * candidates through the ordinary recruiter surface.
   */
  it('does not let a super-admin read an org they do not belong to', async () => {
    await expect(
      as(t, 'superAdmin').query(api.projects.list, {
        orgId: (
          await t.run(async (ctx) =>
            ctx.db
              .query('organizations')
              .withIndex('by_slug', (q) => q.eq('slug', 'acme'))
              .unique(),
          )
        )!._id,
      }),
    ).rejects.toThrow()
  })
})
