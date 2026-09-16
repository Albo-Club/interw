/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { ConvexError } from 'convex/values'
import { beforeEach, describe, expect, it } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

const TOKEN = 'c'.repeat(43)

type Seed = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  sessionId: Id<'sessions'>
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
      title: 'Backend',
      status: 'active',
      language: 'fr',
      introMode: 'none',
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: true, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: userId,
      createdAt: 0,
      restricted: false,
      sessionCount: 1,
      completedSessionCount: 0,
    })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: TOKEN,
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'in_progress',
      consentAcceptedAt: 1,
      lastQuestionIndex: 0,
      invitedBy: userId,
      invitedAt: 0,
      cvKey: `orgs/${orgId}/sessions/SESSION/cv.pdf`,
    })
    await ctx.db.patch('sessions', sessionId, {
      cvKey: `orgs/${orgId}/sessions/${sessionId}/cv.pdf`,
    })
    return { orgId, projectId, sessionId }
  })
}

const keyFor = (s: Seed, name: string) =>
  `orgs/${s.orgId}/sessions/${s.sessionId}/${name}`

/**
 * `attachDocument` deletes the object it replaced. `resolveDocumentUpload`
 * checks the gate and whether the field is even asked for; `swapDocumentKey`,
 * which is what actually rewrites the row, checked neither — so anyone still
 * holding the link could point `cvKey` at a name that does not exist and
 * destroy the CV the recruiter had already read, days after the interview
 * closed.
 */
describe('swapping a document key', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('works while the interview is open', async () => {
    const result = await t.mutation(internal.candidate.swapDocumentKey, {
      token: TOKEN,
      kind: 'cv',
      key: keyFor(s, 'cv.docx'),
    })
    expect(result.previous).toBe(keyFor(s, 'cv.pdf'))
  })

  it('refuses once the interview is over', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('sessions', s.sessionId, { status: 'completed' })
    })
    await expect(
      t.mutation(internal.candidate.swapDocumentKey, {
        token: TOKEN,
        kind: 'cv',
        key: keyFor(s, 'cv.docx'),
      }),
    ).rejects.toThrow(ConvexError)

    const session = await t.run(async (ctx) =>
      ctx.db.get('sessions', s.sessionId),
    )
    expect(session?.cvKey).toBe(keyFor(s, 'cv.pdf'))
  })

  it('refuses once the role is closed', async () => {
    await t.run(async (ctx) => {
      await ctx.db.patch('projects', s.projectId, { status: 'archived' })
    })
    await expect(
      t.mutation(internal.candidate.swapDocumentKey, {
        token: TOKEN,
        kind: 'cv',
        key: keyFor(s, 'cv.docx'),
      }),
    ).rejects.toThrow(ConvexError)
  })

  it('refuses a document the role never asked for', async () => {
    await expect(
      t.mutation(internal.candidate.swapDocumentKey, {
        token: TOKEN,
        kind: 'cover',
        key: keyFor(s, 'cover.pdf'),
      }),
    ).rejects.toThrow(ConvexError)
  })

  it('still refuses a key belonging to another session', async () => {
    await expect(
      t.mutation(internal.candidate.swapDocumentKey, {
        token: TOKEN,
        kind: 'cv',
        key: `orgs/${s.orgId}/sessions/somebody-else/cv.pdf`,
      }),
    ).rejects.toThrow(ConvexError)
  })
})
