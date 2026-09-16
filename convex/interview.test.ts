/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type Seed = { token: string; projectId: Id<'projects'> }

async function seed(t: ReturnType<typeof newTest>): Promise<Seed> {
  const token = 'k'.repeat(43)
  const projectId = await t.run(async (ctx) => {
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
    const project = await ctx.db.insert('projects', {
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
      createdBy: userId,
      createdAt: 0,
      restricted: false,
      sessionCount: 1,
      completedSessionCount: 0,
      // Closed against the real server clock, long ago.
      expiresAt: 1_000,
    })
    await ctx.db.insert('questions', {
      orgId,
      projectId: project,
      orderIndex: 0,
      content: 'Tell me about a migration you led.',
      maxResponseSeconds: 120,
    })
    await ctx.db.insert('sessions', {
      orgId,
      projectId: project,
      accessToken: token,
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'pending',
      consentAcceptedAt: 1,
      lastQuestionIndex: 0,
      invitedBy: userId,
      invitedAt: 0,
    })
    return project
  })
  return { token, projectId }
}

/**
 * The candidate surface has the same shape of hole as the share surface: the
 * gate took `now` from whoever held the link. A role closed weeks ago went on
 * serving its questions and signing playback URLs to anyone who kept an old
 * invitation.
 */
describe('a closed role stays closed', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('refuses the questions however far back the caller claims to be', async () => {
    for (const now of [0, -1]) {
      await expect(
        t.query(api.interview.questions, { token: s.token, now }),
      ).rejects.toThrow('expired')
    }
  })

  it('mints no prompt media URL for a closed role', async () => {
    await expect(
      t.action(api.interview.promptMediaUrls, { token: s.token, now: 0 }),
    ).rejects.toThrow('expired')
  })

  it('serves the questions while the role is open', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('projects', s.projectId, { expiresAt: undefined })
    })
    const result = await t.query(api.interview.questions, {
      token: s.token,
      now: Date.now(),
    })
    expect(result.questions).toHaveLength(1)
  })
})
