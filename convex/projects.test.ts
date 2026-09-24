/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import enProjects from '../src/locales/en/projects.json'
import frProjects from '../src/locales/fr/projects.json'
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
type Who = 'creator' | 'teammate' | 'admin'

/** One draft role, created by a plain member, with one teammate on it. */
async function seed(t: TestConvex) {
  return await t.run(async (ctx) => {
    const users = {} as Record<Who, Id<'users'>>
    for (const who of ['creator', 'teammate', 'admin'] as const) {
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
      createdBy: users.admin,
      createdAt: 0,
    })
    for (const who of ['creator', 'teammate', 'admin'] as const) {
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
      status: 'draft',
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
      sessionCount: 0,
      completedSessionCount: 0,
    })
    await ctx.db.insert('projectShares', {
      orgId,
      projectId,
      userId: users.teammate,
      grantedBy: users.creator,
      grantedAt: 0,
    })
    const questionId = await ctx.db.insert('questions', {
      orgId,
      projectId,
      orderIndex: 0,
      content: 'Tell us about the last outage you ran.',
      maxResponseSeconds: 120,
    })
    const criterionId = await ctx.db.insert('criteria', {
      orgId,
      projectId,
      label: 'Incident handling',
      weight: 10,
      orderIndex: 0,
    })
    return { orgId, projectId, questionId, criterionId }
  })
}

const as = (t: TestConvex, who: Who) => t.withIdentity({ subject: `ba_${who}` })

/**
 * Audit 2026-09-15, recruiter M10. Publishing checked only that one question
 * existed. The wizard seeds a new question and a new criterion with the
 * example its field shows, so a role could go live asking the example
 * question, or scoring against "Technical depth" that nobody chose.
 */
describe('projects.publish', () => {
  let t: TestConvex
  let s: Awaited<ReturnType<typeof seed>>

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  const status = () =>
    t.run(async (ctx) => (await ctx.db.get('projects', s.projectId))?.status)

  it('publishes a role whose questions and criteria were written', async () => {
    await as(t, 'creator').mutation(api.projects.publish, {
      projectId: s.projectId,
    })
    expect(await status()).toBe('active')
  })

  it.each([enProjects, frProjects])(
    'refuses the example question, in either language',
    async (copy) => {
      await t.run((ctx) =>
        ctx.db.patch('questions', s.questionId, {
          content: copy.questions.fields.contentPlaceholder,
        }),
      )
      await expect(
        as(t, 'creator').mutation(api.projects.publish, {
          projectId: s.projectId,
        }),
      ).rejects.toThrow('question_not_written')
      expect(await status()).toBe('draft')
    },
  )

  it('refuses a question left blank', async () => {
    await t.run((ctx) =>
      ctx.db.patch('questions', s.questionId, { content: '   ' }),
    )
    await expect(
      as(t, 'creator').mutation(api.projects.publish, { projectId: s.projectId }),
    ).rejects.toThrow('question_not_written')
  })

  it.each([enProjects, frProjects])(
    'refuses a criterion still named after the example',
    async (copy) => {
      await t.run((ctx) =>
        ctx.db.patch('criteria', s.criterionId, {
          label: copy.criteria.fields.labelPlaceholder,
        }),
      )
      await expect(
        as(t, 'creator').mutation(api.projects.publish, {
          projectId: s.projectId,
        }),
      ).rejects.toThrow('criterion_not_named')
      expect(await status()).toBe('draft')
    },
  )

  it('refuses a role with no criterion to score against', async () => {
    await t.run((ctx) => ctx.db.delete('criteria', s.criterionId))
    await expect(
      as(t, 'creator').mutation(api.projects.publish, { projectId: s.projectId }),
    ).rejects.toThrow('no_criteria')
  })
})

/**
 * Audit 2026-09-15, recruiter E6. `projects.remove` existed with no button.
 * The button now shows to the creator, owners and admins; these pin the
 * server side it relies on.
 */
describe('projects.remove', () => {
  let t: TestConvex
  let s: Awaited<ReturnType<typeof seed>>

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  const exists = () =>
    t.run(async (ctx) => (await ctx.db.get('projects', s.projectId)) !== null)

  it.each(['creator', 'admin'] as const)('lets the %s delete an empty role', async (who) => {
    await as(t, who).mutation(api.projects.remove, { projectId: s.projectId })
    expect(await exists()).toBe(false)
    const leftovers = await t.run(async (ctx) => ({
      questions: await ctx.db.query('questions').collect(),
      criteria: await ctx.db.query('criteria').collect(),
      team: await ctx.db.query('projectShares').collect(),
    }))
    expect(leftovers).toEqual({ questions: [], criteria: [], team: [] })
  })

  it('refuses a teammate who is neither creator nor admin', async () => {
    await expect(
      as(t, 'teammate').mutation(api.projects.remove, { projectId: s.projectId }),
    ).rejects.toThrow('insufficient_role')
    expect(await exists()).toBe(true)
  })

  it('refuses once a candidate was invited', async () => {
    await t.run((ctx) =>
      ctx.db.patch('projects', s.projectId, { sessionCount: 1 }),
    )
    await expect(
      as(t, 'creator').mutation(api.projects.remove, { projectId: s.projectId }),
    ).rejects.toThrow('project_has_sessions')
    expect(await exists()).toBe(true)
  })
})
