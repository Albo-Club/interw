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
  sharedProject: Id<'projects'>
  confidentialProject: Id<'projects'>
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

    const mkProject = (title: string) =>
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
        sessionCount: 0,
        completedSessionCount: 0,
      })

    const sharedProject = await mkProject('Shared')
    await ctx.db.insert('projectShares', {
      orgId,
      projectId: sharedProject,
      userId: memberId,
      grantedBy: authorId,
      grantedAt: 0,
    })
    return {
      orgId,
      otherOrgId,
      authorId,
      memberId,
      sharedProject,
      confidentialProject: await mkProject('Confidential'),
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

  it('shows a role to a member of its team', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.sharedProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(true)
    })
  })

  it('hides a role from a member who is not on its team', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.confidentialProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(false)
    })
  })

  // Audit T17-2: the creator's seat is a row, so removal can revoke it.
  // `createdBy` is attribution and, alone, shows the creator nothing.
  it('hides a role from its creator once their seat is gone', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.confidentialProject))!
      expect(await canSeeProject(ctx, project, s.authorId, 'member')).toBe(false)
    })
  })

  it('shows every role to admins and owners', async () => {
    await t.run(async (ctx) => {
      const project = (await ctx.db.get('projects', s.confidentialProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'admin')).toBe(true)
      expect(await canSeeProject(ctx, project, s.memberId, 'owner')).toBe(true)
    })
  })

  // Decision 3 of 2026-09-24: the open/restricted switch is gone. A row that
  // still says `restricted: false` from before is visible to its team only.
  it('ignores the legacy "open to everyone" flag', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('projects', s.confidentialProject, {
        restricted: false,
      })
      const project = (await ctx.db.get('projects', s.confidentialProject))!
      expect(await canSeeProject(ctx, project, s.memberId, 'member')).toBe(false)
    })
  })
})

describe('filterVisibleProjects', () => {
  it('keeps only the roles a plain member is on the team of', async () => {
    const t = newTest()
    const s = await seed(t)
    await t.run(async (ctx) => {
      const all = await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', s.orgId))
        .collect()
      const visible = await filterVisibleProjects(ctx, all, s.memberId, 'member')
      expect(visible.map((p) => p.title)).toEqual(['Shared'])
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
