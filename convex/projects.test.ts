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
    for (const userId of [users.creator, users.teammate]) {
      await ctx.db.insert('projectShares', {
        orgId,
        projectId,
        userId,
        grantedBy: users.creator,
        grantedAt: 0,
      })
    }
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

/**
 * Audit 2026-09-15, recruiter F6. The list carried a `restricted` flag it
 * never drew; under the role team (decision of 24/09) what an owner or admin
 * needs to spot is which roles they are on — the ones that email them.
 */
describe('projects.list', () => {
  let t: TestConvex
  let s: Awaited<ReturnType<typeof seed>>

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it.each([
    ['creator', true],
    ['teammate', true],
    ['admin', false],
  ] as const)('tells the %s whether they are on the team', async (who, onTeam) => {
    const rows = await as(t, who).query(api.projects.list, { orgId: s.orgId })
    expect(rows.map((row) => row.onTeam)).toEqual([onTeam])
  })
})

/**
 * Audit 2026-09-15, recruiter F9. Accepting an imported draft ran one
 * mutation per question and per criterion: a failure on the fifth left the
 * role half-imported, with nothing saying what had been written.
 */
describe('jobImport.applyDraft', () => {
  let t: TestConvex
  let s: Awaited<ReturnType<typeof seed>>

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  const draft = {
    questions: [
      { title: 'Scale', content: 'How did you scale the last service you owned?' },
      { title: 'Ownership', content: 'Tell us about a decision you reversed.' },
    ],
    criteria: [
      { label: 'Systems thinking', description: 'Trade-offs', weight: 30 },
      { label: 'Ownership', description: '', weight: 20 },
    ],
  }

  const counts = () =>
    t.run(async (ctx) => ({
      questions: (await ctx.db.query('questions').collect()).length,
      criteria: (await ctx.db.query('criteria').collect()).length,
    }))

  it('appends the whole draft after what the role already has', async () => {
    await as(t, 'creator').mutation(api.jobImport.applyDraft, {
      projectId: s.projectId,
      ...draft,
    })
    const rows = await t.run(async (ctx) =>
      (await ctx.db.query('questions').collect()).map((q) => q.orderIndex),
    )
    expect(rows.sort()).toEqual([0, 1, 2])
    expect(await counts()).toEqual({ questions: 3, criteria: 3 })
  })

  it('writes nothing when one row fails validation', async () => {
    await expect(
      as(t, 'creator').mutation(api.jobImport.applyDraft, {
        projectId: s.projectId,
        questions: draft.questions,
        criteria: [...draft.criteria, { label: ' ', description: '', weight: 10 }],
      }),
    ).rejects.toThrow('invalid_label')
    expect(await counts()).toEqual({ questions: 1, criteria: 1 })
  })

  it('refuses a draft that would overflow the question cap', async () => {
    await expect(
      as(t, 'creator').mutation(api.jobImport.applyDraft, {
        projectId: s.projectId,
        questions: Array.from({ length: 25 }, () => draft.questions[0]),
        criteria: [],
      }),
    ).rejects.toThrow('too_many_questions')
    expect(await counts()).toEqual({ questions: 1, criteria: 1 })
  })

  it('refuses someone off the role team', async () => {
    await t.run(async (ctx) => {
      const other = await ctx.db.insert('users', {
        betterAuthId: 'ba_outsider',
        email: 'outsider@acme.test',
        superAdmin: false,
        createdAt: 0,
      })
      await ctx.db.insert('organizationMembers', {
        orgId: s.orgId,
        userId: other,
        role: 'member',
        joinedAt: 0,
      })
    })
    await expect(
      t.withIdentity({ subject: 'ba_outsider' }).mutation(api.jobImport.applyDraft, {
        projectId: s.projectId,
        ...draft,
      }),
    ).rejects.toThrow()
    expect(await counts()).toEqual({ questions: 1, criteria: 1 })
  })
})

/**
 * One title a recruiter types, the one the candidate sees. The internal name
 * is optional and, until one is given, follows the job title — on the server,
 * so no client can let the two drift.
 */
describe('a role title', () => {
  let t: TestConvex
  let s: Awaited<ReturnType<typeof seed>>

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  const titles = (projectId: Id<'projects'>) =>
    t.run(async (ctx) => {
      const project = await ctx.db.get('projects', projectId)
      return { title: project?.title, jobTitle: project?.jobTitle }
    })

  it('is the job title alone until an internal name is given', async () => {
    const { projectId } = await as(t, 'creator').mutation(api.projects.create, {
      orgId: s.orgId,
      jobTitle: '  Backend engineer ',
      language: 'en',
    })
    expect(await titles(projectId)).toEqual({
      title: 'Backend engineer',
      jobTitle: 'Backend engineer',
    })

    await as(t, 'creator').mutation(api.projects.update, {
      projectId,
      jobTitle: 'Senior backend engineer',
    })
    expect(await titles(projectId)).toEqual({
      title: 'Senior backend engineer',
      jobTitle: 'Senior backend engineer',
    })
  })

  it('keeps an internal name when the job title changes', async () => {
    const { projectId } = await as(t, 'creator').mutation(api.projects.create, {
      orgId: s.orgId,
      jobTitle: 'Backend engineer',
      internalTitle: 'Backend - Lyon',
      language: 'en',
    })
    await as(t, 'creator').mutation(api.projects.update, {
      projectId,
      jobTitle: 'Senior backend engineer',
    })
    expect(await titles(projectId)).toEqual({
      title: 'Backend - Lyon',
      jobTitle: 'Senior backend engineer',
    })
  })

  it('refuses to clear the job title a role is named by', async () => {
    const { projectId } = await as(t, 'creator').mutation(api.projects.create, {
      orgId: s.orgId,
      jobTitle: 'Backend engineer',
      language: 'en',
    })
    await expect(
      as(t, 'creator').mutation(api.projects.update, { projectId, jobTitle: ' ' }),
    ).rejects.toThrow('invalid_title')
  })
})
