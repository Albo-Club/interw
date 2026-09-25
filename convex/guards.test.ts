/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { makeFunctionReference } from 'convex/server'

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
 *   acmeOwner    owner of Acme, creator of both roles, seated on both
 *   acmeAdmin    admin of Acme, on neither team
 *   acmeMember   plain member of Acme, on the Backend team only
 *   acmeShared   plain member of Acme, on the Chief of Staff team only
 *   rivalOwner   owner of a different organisation entirely
 *   superAdmin   deployment-wide
 */
type World = {
  acmeOrgId: Id<'organizations'>
  backendProjectId: Id<'projects'>
  chiefProjectId: Id<'projects'>
  sessionId: Id<'sessions'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<World> {
  return await t.run(async (ctx) => {
    const users: Record<string, Id<'users'>> = {}
    for (const [key, superAdmin] of [
      ['acmeOwner', false],
      ['acmeAdmin', false],
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
      [users.acmeAdmin, acmeOrgId, 'admin'],
      [users.acmeMember, acmeOrgId, 'member'],
      [users.acmeShared, acmeOrgId, 'member'],
      [users.rivalOwner, rivalOrgId, 'owner'],
    ] as Array<
      [Id<'users'>, Id<'organizations'>, 'owner' | 'admin' | 'member']
    >) {
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
    const backendProjectId = await ctx.db.insert('projects', {
      ...baseProject,
      slug: 'backend',
      title: 'Backend',
      sessionCount: 1,
    })
    const chiefProjectId = await ctx.db.insert('projects', {
      ...baseProject,
      slug: 'chief-of-staff',
      title: 'Chief of Staff',
      sessionCount: 0,
      completedSessionCount: 0,
    })
    for (const [projectId, userId] of [
      [backendProjectId, users.acmeOwner],
      [chiefProjectId, users.acmeOwner],
      [backendProjectId, users.acmeMember],
      [chiefProjectId, users.acmeShared],
    ] as const) {
      await ctx.db.insert('projectShares', {
        orgId: acmeOrgId,
        projectId,
        userId,
        grantedBy: users.acmeOwner,
        grantedAt: 0,
      })
    }

    const sessionId = await ctx.db.insert('sessions', {
      orgId: acmeOrgId,
      projectId: backendProjectId,
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

    return { acmeOrgId, backendProjectId, chiefProjectId, sessionId }
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
        projectId: w.backendProjectId,
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
 * A role is invisible, not forbidden, to anyone off its team: a recruiter
 * should not learn that a confidential search exists, so the refusal is
 * `not_found`.
 */
describe('project visibility inside an organisation', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('hides a role from a member who is not on its team', async () => {
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

  it('shows it to a member of its team', async () => {
    const detail = await as(t, 'acmeShared').query(api.projects.getBySlug, {
      orgId: w.acmeOrgId,
      slug: 'chief-of-staff',
    })
    expect(detail.project.slug).toBe('chief-of-staff')
  })

  /**
   * Audit 2026-09-22, `convex/emailEvents.ts:recent:org-scope-without-project-visibility`.
   * The org-wide deliverability list lost its only screen when the candidate
   * table started reading each invitation's own delivery (PR #45), so it is
   * gone rather than kept filtered for nobody.
   */
  it('no longer exposes the org-wide deliverability list', async () => {
    await expect(
      as(t, 'acmeMember').query(
        makeFunctionReference<'query'>('emailEvents:recent'),
        { orgId: w.acmeOrgId },
      ),
    ).rejects.toThrow()
  })

  /**
   * Same finding, count variant. `sessions.countsForOrg` had no caller and
   * counted every role's sessions; `dashboard.overview` is the filtered
   * source of the same numbers, so the unfiltered copy is gone rather than
   * kept in sync.
   */
  it('no longer exposes an unfiltered session count', async () => {
    await expect(
      as(t, 'acmeMember').query(
        makeFunctionReference<'query'>('sessions:countsForOrg'),
        { orgId: w.acmeOrgId },
      ),
    ).rejects.toThrow()
  })

  /**
   * Audit 2026-09-15, backend F3. The search box re-implemented the
   * visibility rule instead of asking `canSeeProject`; it now asks, and this
   * pins the outcome so a copy cannot creep back in and drift.
   */
  it('keeps a role off the search results of a member outside its team', async () => {
    const search = (who: string) =>
      as(t, who).query(api.reports.searchCandidates, {
        orgId: w.acmeOrgId,
        text: 'Alex',
      })
    expect(await search('acmeShared')).toEqual([])
    expect((await search('acmeMember')).map((r) => r.projectSlug)).toEqual([
      'backend',
    ])
    expect((await search('acmeAdmin')).map((r) => r.projectSlug)).toEqual([
      'backend',
    ])
  })
})

/** A finished interview with a report on `projectId`; returns who was mailed. */
async function completeInterviewOn(
  t: ReturnType<typeof newTest>,
  w: World,
  projectId: Id<'projects'>,
) {
  const sessionId = await t.run(async (ctx) => {
    const project = (await ctx.db.get('projects', projectId))!
    const id = await ctx.db.insert('sessions', {
      orgId: w.acmeOrgId,
      projectId,
      accessToken: 'r'.repeat(43),
      candidateName: 'Dana Fictional',
      candidateEmail: 'dana@candidate.test',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: project.createdBy,
      invitedAt: 0,
      completedAt: 1,
    })
    await ctx.db.insert('reports', {
      orgId: w.acmeOrgId,
      sessionId: id,
      overallScore: 87,
      recommendation: 'strong_yes',
      executiveSummary: 'Strong.',
      criteriaScores: [],
      strengths: ['Something'],
      concerns: [],
      model: 'test',
      generatedAt: 0,
    })
    return id
  })
  await t.mutation(internal.notifications.sendReportReady, { sessionId })
  return await t.run(async (ctx) =>
    (
      await ctx.db
        .query('emailLog')
        .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
        .collect()
    ).map((row) => row.recipient),
  )
}

/**
 * Audit 2026-09-22, `convex/organizations.ts:removeMember:projectShares-not-revoked`.
 * Membership is the hard boundary: a share or a `createdBy` attribution must
 * not keep acting for someone after they were removed.
 */
describe('removing a member revokes what was granted through them', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  async function removeShared() {
    const membership = await t.run(async (ctx) => {
      const user = await ctx.db
        .query('users')
        .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', 'ba_acmeShared'))
        .unique()
      return (await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', w.acmeOrgId).eq('userId', user!._id),
        )
        .unique())!
    })
    await as(t, 'acmeOwner').mutation(api.organizations.removeMember, {
      orgId: w.acmeOrgId,
      memberId: membership._id,
    })
    return membership.userId
  }

  it('stops mailing reports of a role they were named on', async () => {
    await removeShared()
    const recipients = await completeInterviewOn(t, w, w.chiefProjectId)
    expect(recipients).not.toContain('acmeShared@example.test')
    expect(recipients).toContain('acmeOwner@example.test')
  })

  it('still credits them as the creator of their roles', async () => {
    const userId = await removeShared()
    await t.run(async (ctx) =>
      ctx.db.patch('projects', w.backendProjectId, { createdBy: userId }),
    )
    const team = await as(t, 'acmeOwner').query(api.projects.team, {
      projectId: w.backendProjectId,
    })
    expect(team.creator).toEqual({
      name: 'acmeShared@example.test',
      removed: true,
    })
  })

  it('stops mailing reports of a role they created', async () => {
    const userId = await removeShared()
    await t.run(async (ctx) =>
      ctx.db.patch('projects', w.backendProjectId, { createdBy: userId }),
    )
    const recipients = await completeInterviewOn(t, w, w.backendProjectId)
    expect(recipients).not.toContain('acmeShared@example.test')
    expect(recipients).toContain('acmeMember@example.test')
  })

  /** PR #43: a creator who left alone on their role left it mailing nobody. */
  it('hands the reports of a role left with nobody to the admins', async () => {
    const userId = await removeShared()
    await t.run(async (ctx) => {
      await ctx.db.patch('projects', w.backendProjectId, { createdBy: userId })
      for (const row of await ctx.db
        .query('projectShares')
        .withIndex('by_project', (q) => q.eq('projectId', w.backendProjectId))
        .collect()) {
        await ctx.db.delete('projectShares', row._id)
      }
    })
    const recipients = await completeInterviewOn(t, w, w.backendProjectId)
    expect(recipients.sort()).toEqual([
      'acmeAdmin@example.test',
      'acmeOwner@example.test',
    ])
  })

  it('does not put them back on the team on re-invitation', async () => {
    const userId = await removeShared()
    await t.run(async (ctx) =>
      ctx.db.insert('organizationMembers', {
        orgId: w.acmeOrgId,
        userId,
        role: 'member',
        joinedAt: 2,
      }),
    )
    await expect(
      as(t, 'acmeShared').query(api.projects.getBySlug, {
        orgId: w.acmeOrgId,
        slug: 'chief-of-staff',
      }),
    ).rejects.toThrow('not_found')
  })
})

const userId = (t: ReturnType<typeof newTest>, who: string) =>
  t.run(async (ctx) =>
    (await ctx.db
      .query('users')
      .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', `ba_${who}`))
      .unique())!._id,
  )

const teamRowsOf = (t: ReturnType<typeof newTest>, projectId: Id<'projects'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('projectShares')
        .withIndex('by_project', (q) => q.eq('projectId', projectId))
        .collect()
    ).map((row) => row.userId),
  )

/**
 * Audit T04, decision 3 of 2026-09-24: a role's team — its creator plus the
 * colleagues they chose — decides both who sees it (with admins and owners)
 * and who is mailed when one of its reports is ready. It replaces the
 * open/restricted switch and the org-wide mailing (Pipe M6).
 */
describe("the role's team", () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  /** B8: the dialog used to open empty, and saving it wiped the team. */
  it('opening the team and saving it unchanged leaves it intact', async () => {
    const team = await as(t, 'acmeOwner').query(api.projects.team, {
      projectId: w.chiefProjectId,
    })
    expect(team.members).toEqual([
      await userId(t, 'acmeOwner'),
      await userId(t, 'acmeShared'),
    ])
    expect(team.creator).toEqual({
      name: 'acmeOwner@example.test',
      removed: false,
    })

    await as(t, 'acmeOwner').mutation(api.projects.setTeam, {
      projectId: w.chiefProjectId,
      userIds: team.members,
    })
    expect(await teamRowsOf(t, w.chiefProjectId)).toEqual(team.members)
    const detail = await as(t, 'acmeShared').query(api.projects.getBySlug, {
      orgId: w.acmeOrgId,
      slug: 'chief-of-staff',
    })
    expect(detail.project.slug).toBe('chief-of-staff')
  })

  it('a member off the team neither sees the role nor is mailed about it', async () => {
    await expect(
      as(t, 'acmeMember').query(api.projects.getBySlug, {
        orgId: w.acmeOrgId,
        slug: 'chief-of-staff',
      }),
    ).rejects.toThrow('not_found')
    const recipients = await completeInterviewOn(t, w, w.chiefProjectId)
    expect(recipients.sort()).toEqual([
      'acmeOwner@example.test',
      'acmeShared@example.test',
    ])
  })

  it('an admin sees every role but is mailed only about the ones they follow', async () => {
    const detail = await as(t, 'acmeAdmin').query(api.projects.getBySlug, {
      orgId: w.acmeOrgId,
      slug: 'chief-of-staff',
    })
    expect(detail.project.slug).toBe('chief-of-staff')
    expect(await completeInterviewOn(t, w, w.chiefProjectId)).not.toContain(
      'acmeAdmin@example.test',
    )

    await as(t, 'acmeOwner').mutation(api.projects.setTeam, {
      projectId: w.backendProjectId,
      userIds: [await userId(t, 'acmeAdmin')],
    })
    expect(await completeInterviewOn(t, w, w.backendProjectId)).toContain(
      'acmeAdmin@example.test',
    )
  })

  /** A role created before the team existed and left "open to everyone" is
   *  read as its creator's alone, with no migration: the flag is ignored. */
  it('reads a formerly open role as visible to its team only', async () => {
    await t.run(async (ctx) =>
      ctx.db.patch('projects', w.chiefProjectId, { restricted: false }),
    )
    await expect(
      as(t, 'acmeMember').query(api.projects.getBySlug, {
        orgId: w.acmeOrgId,
        slug: 'chief-of-staff',
      }),
    ).rejects.toThrow('not_found')
    const list = await as(t, 'acmeMember').query(api.projects.list, {
      orgId: w.acmeOrgId,
    })
    expect(list.map((p) => p.slug)).toEqual(['backend'])
  })

  /** Back F7: the list a caller hands in is bounded. */
  it('refuses a team of more than 100', async () => {
    const someone = await userId(t, 'acmeMember')
    await expect(
      as(t, 'acmeOwner').mutation(api.projects.setTeam, {
        projectId: w.backendProjectId,
        userIds: Array.from({ length: 101 }, () => someone),
      }),
    ).rejects.toThrow('team_too_large')
  })

  it('refuses someone from another organisation', async () => {
    await expect(
      as(t, 'acmeOwner').mutation(api.projects.setTeam, {
        projectId: w.backendProjectId,
        userIds: [await userId(t, 'rivalOwner')],
      }),
    ).rejects.toThrow('not_a_member')
  })

  it('lets only the creator, an admin or an owner change or read the team', async () => {
    await expect(
      as(t, 'acmeMember').mutation(api.projects.setTeam, {
        projectId: w.backendProjectId,
        userIds: [],
      }),
    ).rejects.toThrow('insufficient_role')
    await expect(
      as(t, 'acmeMember').query(api.projects.team, {
        projectId: w.backendProjectId,
      }),
    ).rejects.toThrow('insufficient_role')
    expect(await teamRowsOf(t, w.backendProjectId)).toEqual([
      await userId(t, 'acmeOwner'),
      await userId(t, 'acmeMember'),
    ])
  })

  it("keeps the creator's seat through a team that leaves them out", async () => {
    await as(t, 'acmeAdmin').mutation(api.projects.setTeam, {
      projectId: w.backendProjectId,
      userIds: [],
    })
    expect(await teamRowsOf(t, w.backendProjectId)).toEqual([
      await userId(t, 'acmeOwner'),
    ])
    expect(await completeInterviewOn(t, w, w.backendProjectId)).toEqual([
      'acmeOwner@example.test',
    ])
  })

  it('sets the team when the role is created', async () => {
    const shared = await userId(t, 'acmeShared')
    await expect(
      as(t, 'acmeMember').mutation(api.projects.create, {
        orgId: w.acmeOrgId,
        title: 'Designer',
        language: 'en',
        team: [shared, await userId(t, 'rivalOwner')],
      }),
    ).rejects.toThrow('not_a_member')

    const { projectId, slug } = await as(t, 'acmeMember').mutation(
      api.projects.create,
      { orgId: w.acmeOrgId, title: 'Designer', language: 'en', team: [shared] },
    )
    expect(await teamRowsOf(t, projectId)).toEqual([
      await userId(t, 'acmeMember'),
      shared,
    ])
    const detail = await as(t, 'acmeShared').query(api.projects.getBySlug, {
      orgId: w.acmeOrgId,
      slug,
    })
    expect(detail.project.title).toBe('Designer')
  })
})

/**
 * h03 and Back F9 / h05: a report link acts for whoever created it, and a
 * place on a team is an attribution inside the org. Neither may outlive the
 * membership, or the account.
 */
describe('leaving revokes team places and report links', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  const linkStates = () =>
    t.run(async (ctx) =>
      Object.fromEntries(
        (await ctx.db.query('reportShares').collect()).map((link) => [
          link.createdBy,
          link.revokedAt !== undefined,
        ]),
      ),
    )

  async function shareAs(who: string) {
    const createdBy = await userId(t, who)
    await t.run(async (ctx) => {
      const report = (await ctx.db
        .query('reports')
        .withIndex('by_session', (q) => q.eq('sessionId', w.sessionId))
        .unique())!
      await ctx.db.insert('reportShares', {
        orgId: w.acmeOrgId,
        reportId: report._id,
        token: `${who}-link`,
        createdBy,
        viewCount: 0,
        createdAt: 0,
      })
    })
  }

  it('revokes the report links a removed member created, and only theirs', async () => {
    await shareAs('acmeMember')
    await shareAs('acmeOwner')
    const member = await userId(t, 'acmeMember')
    const membership = await t.run(async (ctx) =>
      ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', w.acmeOrgId).eq('userId', member),
        )
        .unique(),
    )
    await as(t, 'acmeOwner').mutation(api.organizations.removeMember, {
      orgId: w.acmeOrgId,
      memberId: membership!._id,
    })
    expect(await linkStates()).toEqual({
      [member]: true,
      [await userId(t, 'acmeOwner')]: false,
    })
    expect(await teamRowsOf(t, w.backendProjectId)).toEqual([
      await userId(t, 'acmeOwner'),
    ])
  })

  it('clears team places and revokes links when the account is deleted', async () => {
    await shareAs('acmeMember')
    const member = await userId(t, 'acmeMember')
    await t.mutation(internal.users.cascadeDelete, {
      betterAuthId: 'ba_acmeMember',
    })
    expect(await linkStates()).toEqual({ [member]: true })
    expect(await teamRowsOf(t, w.backendProjectId)).toEqual([
      await userId(t, 'acmeOwner'),
    ])
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
        projectId: w.backendProjectId,
      }),
    ).rejects.toThrow()

    const project = await t.run(async (ctx) =>
      ctx.db.get('projects', w.backendProjectId),
    )
    expect(project?.status).toBe('active')
  })

  /**
   * Audit 2026-09-22, `convex/projects.ts:restore:requireProjectAccess-weaker-than-archive`.
   * Restoring lifts the freeze and, via `publish`, reopens every link the
   * archival closed: it is the same decision in reverse, so the same tier.
   */
  it('refuses a plain member the right to restore an archived role', async () => {
    await as(t, 'acmeOwner').mutation(api.projects.archive, {
      projectId: w.backendProjectId,
    })
    await expect(
      as(t, 'acmeMember').mutation(api.projects.restore, {
        projectId: w.backendProjectId,
      }),
    ).rejects.toThrow('insufficient_role')

    const project = await t.run(async (ctx) =>
      ctx.db.get('projects', w.backendProjectId),
    )
    expect(project?.status).toBe('archived')
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
      projectId: w.backendProjectId,
    })
    const project = await t.run(async (ctx) =>
      ctx.db.get('projects', w.backendProjectId),
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
    expect(overview.orgs).toEqual({ count: 2, capped: false })
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

/**
 * Audit 2026-09-22, `convex/files.ts:setMyAvatar:storageId-unbound-to-caller`.
 * Convex storage has no per-file owner: the reference in our own rows is the
 * only ownership record, so an avatar may only claim a blob nobody else holds.
 */
describe('storage handles', () => {
  let t: ReturnType<typeof newTest>
  let w: World
  let logoId: Id<'_storage'>

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
    logoId = await t.run(async (ctx) => {
      const id = await ctx.storage.store(new Blob(['logo']))
      await ctx.db.patch('organizations', w.acmeOrgId, { logoStorageId: id })
      return id
    })
  })

  const blobExists = (id: Id<'_storage'>) =>
    t.run(async (ctx) => (await ctx.db.system.get('_storage', id)) !== null)

  it('does not hand the logo’s storage id to members', async () => {
    const org = await as(t, 'acmeMember').query(api.organizations.bySlug, {
      slug: 'acme',
    })
    expect(org).not.toHaveProperty('logoStorageId')
    expect(org?.logoUrl).toBeTruthy()
  })

  it('refuses to attach the organisation logo as an avatar', async () => {
    await expect(
      as(t, 'acmeMember').mutation(api.files.setMyAvatar, {
        storageId: logoId,
      }),
    ).rejects.toThrow('not_found')
    await as(t, 'acmeMember').mutation(api.files.removeMyAvatar, {})
    expect(await blobExists(logoId)).toBe(true)
  })

  it('refuses to attach a colleague’s avatar', async () => {
    const avatarId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['avatar'])),
    )
    await as(t, 'acmeOwner').mutation(api.files.setMyAvatar, {
      storageId: avatarId,
    })
    await expect(
      as(t, 'acmeMember').mutation(api.files.setMyAvatar, {
        storageId: avatarId,
      }),
    ).rejects.toThrow('not_found')
    expect(await blobExists(avatarId)).toBe(true)
  })

  it('does not delete a blob still referenced elsewhere when an account is deleted', async () => {
    // A row written before the claim check existed may point at the logo.
    await t.run(async (ctx) => {
      const member = (await ctx.db
        .query('users')
        .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', 'ba_acmeMember'))
        .unique())!
      await ctx.db.patch('users', member._id, { avatarStorageId: logoId })
    })
    await t.mutation(internal.users.cascadeDelete, {
      betterAuthId: 'ba_acmeMember',
    })
    expect(await blobExists(logoId)).toBe(true)
  })

  it('still deletes an avatar only that account held', async () => {
    const avatarId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['avatar'])),
    )
    await as(t, 'acmeMember').mutation(api.files.setMyAvatar, {
      storageId: avatarId,
    })
    await t.mutation(internal.users.cascadeDelete, {
      betterAuthId: 'ba_acmeMember',
    })
    expect(await blobExists(avatarId)).toBe(false)
  })

  it('still deletes the account when its avatar blob is already gone', async () => {
    const avatarId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['avatar'])),
    )
    await as(t, 'acmeMember').mutation(api.files.setMyAvatar, {
      storageId: avatarId,
    })
    await t.run((ctx) => ctx.storage.delete(avatarId))
    await t.mutation(internal.users.cascadeDelete, {
      betterAuthId: 'ba_acmeMember',
    })
    const row = await t.run((ctx) =>
      ctx.db
        .query('users')
        .withIndex('by_betterAuthId', (q) => q.eq('betterAuthId', 'ba_acmeMember'))
        .unique(),
    )
    expect(row).toBeNull()
  })

  it('keeps the blob when an avatar is re-attached', async () => {
    const avatarId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(['avatar'])),
    )
    for (let i = 0; i < 2; i++) {
      await as(t, 'acmeMember').mutation(api.files.setMyAvatar, {
        storageId: avatarId,
      })
    }
    expect(await blobExists(avatarId)).toBe(true)
  })
})
