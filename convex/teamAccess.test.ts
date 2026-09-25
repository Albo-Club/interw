/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { register as registerAgent } from '@convex-dev/agent/test'
import { createThread } from '@convex-dev/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, components, internal } from './_generated/api'
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
  registerAgent(t, 'agent')
  return t
}

type TestConvex = ReturnType<typeof newTest>
const PEOPLE = ['owner', 'admin', 'creator', 'teammate'] as const
type Who = (typeof PEOPLE)[number]

type World = {
  orgId: Id<'organizations'>
  users: Record<Who, Id<'users'>>
  projectId: Id<'projects'>
  slug: string
  sessionId: Id<'sessions'>
  reportId: Id<'reports'>
}

const as = (t: TestConvex, who: Who) => t.withIdentity({ subject: `ba_${who}` })

/**
 * Acme, and one role created through `projects.create` by a plain member,
 * with a teammate on it and one finished candidate.
 */
async function seed(t: TestConvex): Promise<World> {
  const people = await t.run(async (ctx) => {
    const users = {} as Record<Who, Id<'users'>>
    for (const who of PEOPLE) {
      users[who] = await ctx.db.insert('users', {
        betterAuthId: `ba_${who}`,
        email: `${who}@acme.test`,
        superAdmin: false,
        createdAt: 0,
      })
    }
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: users.owner,
      createdAt: 0,
    })
    for (const who of PEOPLE) {
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId: users[who],
        role: who === 'owner' || who === 'admin' ? who : 'member',
        joinedAt: 0,
      })
    }
    return { orgId, users }
  })
  const { orgId, users } = people

  const { projectId, slug } = await as(t, 'creator').mutation(
    api.projects.create,
    {
      orgId,
      title: 'Backend',
      language: 'en',
      team: [users.teammate],
    },
  )
  const candidate = await t.run(async (ctx) => {
    await ctx.db.patch('projects', projectId, { status: 'active' })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: 'a'.repeat(43),
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@candidate.test',
      status: 'completed',
      lastQuestionIndex: 1,
      invitedBy: users.creator,
      invitedAt: 0,
      completedAt: 1,
    })
    const reportId = await ctx.db.insert('reports', {
      orgId,
      sessionId,
      overallScore: 71,
      recommendation: 'yes',
      executiveSummary: 'Solid.',
      criteriaScores: [],
      strengths: [],
      concerns: [],
      model: 'test',
      generatedAt: 0,
    })
    return { sessionId, reportId }
  })
  return { ...people, projectId, slug, ...candidate }
}

async function removeFromOrg(t: TestConvex, w: World, who: Who) {
  const membership = await t.run(async (ctx) =>
    ctx.db
      .query('organizationMembers')
      .withIndex('by_org_and_user', (q) =>
        q.eq('orgId', w.orgId).eq('userId', w.users[who]),
      )
      .unique(),
  )
  await as(t, 'owner').mutation(api.organizations.removeMember, {
    orgId: w.orgId,
    memberId: membership!._id,
  })
}

async function reinvite(t: TestConvex, w: World, who: Who) {
  await t.run(async (ctx) =>
    ctx.db.insert('organizationMembers', {
      orgId: w.orgId,
      userId: w.users[who],
      role: 'member',
      joinedAt: 2,
    }),
  )
}

const teamOf = (t: TestConvex, projectId: Id<'projects'>) =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('projectShares')
        .withIndex('by_project', (q) => q.eq('projectId', projectId))
        .collect()
    ).map((row) => row.userId),
  )

/** Every action one tier above the team, as `who`. */
function ownerTier(t: TestConvex, w: World, who: Who) {
  const caller = as(t, who)
  return {
    invitationLink: () =>
      caller.query(api.sessions.invitationLink, { sessionId: w.sessionId }),
    cancel: () => caller.mutation(api.sessions.cancel, { sessionId: w.sessionId }),
    deleteCandidateData: () =>
      caller.action(api.sessions.deleteCandidateData, {
        sessionId: w.sessionId,
      }),
    relaunch: () =>
      caller.mutation(api.reports.relaunch, { sessionId: w.sessionId }),
    team: () => caller.query(api.projects.team, { projectId: w.projectId }),
    setTeam: () =>
      caller.mutation(api.projects.setTeam, {
        projectId: w.projectId,
        userIds: [],
      }),
    archive: () =>
      caller.mutation(api.projects.archive, { projectId: w.projectId }),
    remove: () => caller.mutation(api.projects.remove, { projectId: w.projectId }),
  }
}

/**
 * Audit T17-2. The creator's seat on the team was `projects.createdBy`, which
 * removal cannot touch: a creator removed and re-invited as a plain member got
 * back every role they had opened, candidate links included. The seat is now
 * a team row, revoked with the membership like everyone else's.
 */
describe('the creator seat', () => {
  let t: TestConvex
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('is a team row, written when the role is created', async () => {
    expect((await teamOf(t, w.projectId)).sort()).toEqual(
      [w.users.creator, w.users.teammate].sort(),
    )
  })

  it('is revoked with the membership: re-invited, the creator gets not_found', async () => {
    await removeFromOrg(t, w, 'creator')
    await reinvite(t, w, 'creator')

    await expect(
      as(t, 'creator').query(api.projects.getBySlug, {
        orgId: w.orgId,
        slug: w.slug,
      }),
    ).rejects.toThrow('not_found')
    const list = await as(t, 'creator').query(api.projects.list, {
      orgId: w.orgId,
    })
    expect(list).toEqual([])
    for (const [name, call] of Object.entries(ownerTier(t, w, 'creator'))) {
      await expect(call(), name).rejects.toThrow('not_found')
    }
  })

  it('keeps the owner tier for a creator who is still on the team', async () => {
    vi.stubEnv('SITE_URL', 'https://interw.test')
    const tier = ownerTier(t, w, 'creator')
    await expect(tier.invitationLink()).resolves.toMatchObject({
      url: expect.stringContaining('a'.repeat(43)),
    })
    await expect(tier.team()).resolves.toMatchObject({
      createdBy: w.users.creator,
    })
    await tier.setTeam()
    // Nobody unticks the creator: `setTeam([])` leaves their row in place.
    expect(await teamOf(t, w.projectId)).toEqual([w.users.creator])
    await tier.archive()
    await tier.remove()
  })

  it('refuses a teammate the owner tier', async () => {
    await expect(ownerTier(t, w, 'teammate').setTeam()).rejects.toThrow(
      'insufficient_role',
    )
  })

  it('comes back only when someone puts the creator back on the team', async () => {
    await removeFromOrg(t, w, 'creator')
    await reinvite(t, w, 'creator')
    await as(t, 'admin').mutation(api.projects.setTeam, {
      projectId: w.projectId,
      userIds: [w.users.creator],
    })
    const detail = await as(t, 'creator').query(api.projects.getBySlug, {
      orgId: w.orgId,
      slug: w.slug,
    })
    expect(detail.project._id).toBe(w.projectId)
  })
})

/**
 * Audit T17-3. `uniqueSlug` counted up from the title across every role in
 * the organisation, and handed the result back: "Replace Paul" coming back as
 * `replace-paul-2` told a member that a role of that title existed, hidden
 * from them.
 */
describe('new role slugs', () => {
  let t: TestConvex
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('do not depend on roles the caller cannot see', async () => {
    const hidden = await as(t, 'admin').mutation(api.projects.create, {
      orgId: w.orgId,
      title: 'Replace Paul',
      language: 'en',
    })
    const create = (title: string) =>
      as(t, 'teammate').mutation(api.projects.create, {
        orgId: w.orgId,
        title,
        language: 'en',
      })
    const taken = await create('Replace Paul')
    const free = await create('Replace Jane')

    expect(taken.slug).toMatch(/^replace-paul-[a-z0-9]{6}$/)
    expect(free.slug).toMatch(/^replace-jane-[a-z0-9]{6}$/)
    expect(taken.slug).not.toBe(hidden.slug)
  })
})

/**
 * Audit T17 hardening notes (T10, T04/T09). Leaving a role's team used to
 * take away the role and nothing else: the report links the member had made
 * on its candidates kept working, and their assistant threads kept the
 * candidates they had read.
 */
describe('leaving a role team', () => {
  let t: TestConvex
  let w: World

  beforeEach(async () => {
    vi.useFakeTimers()
    t = newTest()
    w = await seed(t)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function shareAs(who: Who, reportId = w.reportId) {
    return await t.run(async (ctx) =>
      ctx.db.insert('reportShares', {
        orgId: w.orgId,
        reportId,
        token: `${who}-${reportId}`,
        createdBy: w.users[who],
        viewCount: 0,
        createdAt: 0,
      }),
    )
  }

  const revoked = (shareId: Id<'reportShares'>) =>
    t.run(
      async (ctx) =>
        (await ctx.db.get('reportShares', shareId))?.revokedAt !== undefined,
    )

  /** A thread in `who`'s scope that read `sessionId`, as the tools record it. */
  async function threadThatRead(who: Who, sessionId = w.sessionId) {
    return await t.run(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {
        userId: `${w.orgId}:${w.users[who]}`,
      })
      await ctx.db.insert('chatThreadSessions', { threadId, sessionId })
      return threadId
    })
  }

  const exists = (threadId: string) =>
    t.run(
      async (ctx) =>
        (await ctx.runQuery(components.agent.threads.getThread, {
          threadId,
        })) !== null,
    )

  async function otherRole() {
    const { projectId } = await as(t, 'owner').mutation(api.projects.create, {
      orgId: w.orgId,
      title: 'Design',
      language: 'en',
      team: [w.users.teammate],
    })
    return await t.run(async (ctx) => {
      const sessionId = await ctx.db.insert('sessions', {
        orgId: w.orgId,
        projectId,
        accessToken: 'b'.repeat(43),
        candidateName: 'Sam Other',
        candidateEmail: 'sam@candidate.test',
        status: 'completed',
        lastQuestionIndex: 1,
        invitedBy: w.users.owner,
        invitedAt: 0,
        completedAt: 1,
      })
      const reportId = await ctx.db.insert('reports', {
        orgId: w.orgId,
        sessionId,
        overallScore: 60,
        recommendation: 'maybe',
        executiveSummary: 'Fine.',
        criteriaScores: [],
        strengths: [],
        concerns: [],
        model: 'test',
        generatedAt: 0,
      })
      return { sessionId, reportId }
    })
  }

  async function dropFromTeam(who: Who) {
    const rest = (await teamOf(t, w.projectId)).filter(
      (id) => id !== w.users[who],
    )
    await as(t, 'creator').mutation(api.projects.setTeam, {
      projectId: w.projectId,
      userIds: rest,
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }

  it('revokes the report links they made on that role, and only those', async () => {
    const other = await otherRole()
    const onRole = await shareAs('teammate')
    const elsewhere = await shareAs('teammate', other.reportId)
    const creators = await shareAs('creator')

    await dropFromTeam('teammate')

    expect(await revoked(onRole)).toBe(true)
    expect(await revoked(elsewhere)).toBe(false)
    expect(await revoked(creators)).toBe(false)
  })

  it("erases their assistant threads that read the role's candidates", async () => {
    const other = await otherRole()
    const readRole = await threadThatRead('teammate')
    const readOther = await threadThatRead('teammate', other.sessionId)
    const creatorsThread = await threadThatRead('creator')

    await dropFromTeam('teammate')

    expect(await exists(readRole)).toBe(false)
    expect(await exists(readOther)).toBe(true)
    expect(await exists(creatorsThread)).toBe(true)
    const rows = await t.run(async (ctx) =>
      ctx.db.query('chatThreadSessions').collect(),
    )
    expect(rows.map((row) => row.threadId).sort()).toEqual(
      [readOther, creatorsThread].sort(),
    )
  })

  it('does the same when they leave the organisation', async () => {
    const link = await shareAs('teammate')
    const thread = await threadThatRead('teammate')

    await removeFromOrg(t, w, 'teammate')
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(await revoked(link)).toBe(true)
    expect(await exists(thread)).toBe(false)
  })

  it('leaves an admin, who still sees the role, their links and threads', async () => {
    await as(t, 'creator').mutation(api.projects.setTeam, {
      projectId: w.projectId,
      userIds: [w.users.teammate, w.users.admin],
    })
    const link = await shareAs('admin')
    const thread = await threadThatRead('admin')

    await dropFromTeam('admin')

    expect(await teamOf(t, w.projectId)).not.toContain(w.users.admin)
    expect(await revoked(link)).toBe(false)
    expect(await exists(thread)).toBe(true)
  })
})

/**
 * The creator seat as a row is only true of roles created from now on; the
 * roles that already exist get theirs from a one-off migration, which skips a
 * creator who has since left — their seat was exactly what removal revokes.
 */
describe('migrations.backfillCreatorSeats', () => {
  let t: TestConvex
  let w: World

  beforeEach(async () => {
    vi.useFakeTimers()
    t = newTest()
    w = await seed(t)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function legacyRole(creator: Id<'users'>, slug: string) {
    return await t.run(async (ctx) => {
      const base = (await ctx.db.get('projects', w.projectId))!
      const { _id, _creationTime, ...fields } = base
      return await ctx.db.insert('projects', {
        ...fields,
        slug,
        createdBy: creator,
      })
    })
  }

  async function run() {
    await t.mutation(internal.migrations.backfillCreatorSeats, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }

  it('seats every current creator once, and nobody who has left', async () => {
    const legacy = []
    for (let i = 0; i < 120; i++) {
      legacy.push(await legacyRole(w.users.teammate, `legacy-${i}`))
    }
    const orphan = await legacyRole(w.users.creator, 'orphan')
    await t.run(async (ctx) => {
      const membership = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', w.orgId).eq('userId', w.users.creator),
        )
        .unique()
      await ctx.db.delete('organizationMembers', membership!._id)
    })

    await run()
    await run()

    for (const projectId of legacy) {
      expect(await teamOf(t, projectId)).toEqual([w.users.teammate])
    }
    expect(await teamOf(t, orphan)).toEqual([])
    // The seeded role already had its creator's row; no second one.
    expect((await teamOf(t, w.projectId)).sort()).toEqual(
      [w.users.creator, w.users.teammate].sort(),
    )
    const state = await t.run(async (ctx) =>
      ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', 'backfillCreatorSeats'))
        .unique(),
    )
    expect(state?.doneAt).toBeDefined()
  })
})
