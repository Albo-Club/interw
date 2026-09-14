/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it } from 'vitest'

import schema from '../schema'
import { canSeeProject, filterVisibleProjects } from './projectAccess'
import type { Id } from '../_generated/dataModel'

const modules = import.meta.glob('../**/*.ts')

type Seed = {
  orgId: Id<'organizations'>
  otherOrgId: Id<'organizations'>
  authorId: Id<'users'>
  memberId: Id<'users'>
  openProject: Id<'projects'>
  restrictedProject: Id<'projects'>
}

function newTest() {
  return convexTest(schema, modules)
}

async function seed(t: ReturnType<typeof newTest>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const mkUser = (email: string) =>
      ctx.db.insert('users', {
        betterAuthId: `ba_${email}`,
        email,
        superAdmin: false,
        createdAt: 0,
      })
    const authorId = await mkUser('author@acme.test')
    const memberId = await mkUser('member@acme.test')

    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: authorId,
      createdAt: 0,
    })
    const otherOrgId = await ctx.db.insert('organizations', {
      slug: 'globex',
      name: 'Globex',
      createdBy: authorId,
      createdAt: 0,
    })

    const mkProject = (title: string, restricted: boolean) =>
      ctx.db.insert('projects', {
        orgId,
        slug: title.toLowerCase(),
        title,
        status: 'active' as const,
        language: 'fr' as const,
        introMode: 'none' as const,
        maxDurationMinutes: 20,
        candidateFields: {
          phone: { enabled: false, required: false },
          linkedin: { enabled: false, required: false },
          cv: { enabled: true, required: false },
          coverLetter: { enabled: false, required: false },
        },
        createdBy: authorId,
        createdAt: 0,
        restricted,
        sessionCount: 0,
        completedSessionCount: 0,
      })

    return {
      orgId,
      otherOrgId,
      authorId,
      memberId,
      openProject: await mkProject('Open', false),
      restrictedProject: await mkProject('Confidential', true),
    }
  })
}

describe('project visibility', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('shows an unrestricted project to any member', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.openProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(true)
    })
  })

  it('hides a restricted project from a member who was not named', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.restrictedProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(false)
    })
  })

  it('still shows a restricted project to its creator', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.restrictedProject))!
      expect(await canSeeProject(ctx, project, s.authorId, 'member')).toBe(true)
    })
  })

  it('shows a restricted project to admins and owners', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.restrictedProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'admin')).toBe(true)
      expect(await canSeeProject(ctx, project, s.memberId, 'owner')).toBe(true)
    })
  })

  it('shows a restricted project once the member is named on it', async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert('projectShares', {
        orgId: s.orgId,
        projectId: s.restrictedProject,
        userId: s.memberId,
        grantedBy: s.authorId,
        grantedAt: 0,
      })
      const project = (await ctx.db.get('projects', s.restrictedProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(true)
    })
  })

  // A share on ANOTHER project must not unlock this one.
  it('does not let a share on one project leak into another', async () => {
    await t.run(async (ctx) => {
      await ctx.db.insert('projectShares', {
        orgId: s.orgId,
        projectId: s.openProject,
        userId: s.memberId,
        grantedBy: s.authorId,
        grantedAt: 0,
      })
      const project = (await ctx.db.get('projects', s.restrictedProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(false)
    })
  })
})

describe('filterVisibleProjects', () => {
  it('drops restricted rows for a plain member, with one shares query', async () => {
    const t = newTest()
    const s = await seed(t)
    await t.run(async (ctx) => {
      const all = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', s.orgId))
        .collect()
      const visible = await filterVisibleProjects(ctx, all, s.memberId, 'member')
      expect(visible.map((p) => p.title)).toEqual(['Open'])
    })
  })

  it('returns everything for an admin without touching shares', async () => {
    const t = newTest()
    const s = await seed(t)
    await t.run(async (ctx) => {
      const all = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', s.orgId))
        .collect()
      const visible = await filterVisibleProjects(ctx, all, s.memberId, 'admin')
      expect(visible).toHaveLength(2)
    })
  })

  it('never reaches across organisations', async () => {
    const t = newTest()
    const s = await seed(t)
    await t.run(async (ctx) => {
      const otherOrgProjects = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', s.otherOrgId))
        .collect()
      expect(otherOrgProjects).toHaveLength(0)
    })
  })
})
