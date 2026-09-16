/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  return convexTest(schema, modules)
}

type Fixture = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  userId: Id<'users'>
}

async function seed(t: ReturnType<typeof newTest>): Promise<Fixture> {
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
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: userId,
      createdAt: 0,
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    return { orgId, projectId, userId }
  })
}

let counter = 0

async function insertSession(
  t: ReturnType<typeof newTest>,
  f: Fixture,
  fields: {
    status?: 'pending' | 'in_progress' | 'completed'
    purgeAfter?: number
    mediaPurgedAt?: number
  },
): Promise<Id<'sessions'>> {
  counter += 1
  const n = counter
  return await t.run(async (ctx) =>
    ctx.db.insert('sessions', {
      orgId: f.orgId,
      projectId: f.projectId,
      accessToken: String(n).padStart(43, 'a'),
      candidateName: `Candidate ${n}`,
      candidateEmail: `c${n}@example.test`,
      status: fields.status ?? 'pending',
      lastQuestionIndex: 0,
      invitedBy: f.userId,
      invitedAt: 0,
      purgeAfter: fields.purgeAfter,
      mediaPurgedAt: fields.mediaPurgedAt,
    }),
  )
}

/**
 * `purgeAfter` is optional, and an absent field sorts before every value in a
 * Convex index. A range bounded only from above therefore starts at the very
 * beginning of the index and is filled by sessions that have no retention
 * clock at all — which is every `pending` and `in_progress` session on the
 * deployment. These tests hold the range to naming only what it means to name.
 */
describe('sessionsDueForPurge', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    t = newTest()
    f = await seed(t)
  })

  it('finds the one due session behind 40 sessions that have no clock', async () => {
    for (let i = 0; i < 40; i++) {
      await insertSession(t, f, { status: 'pending' })
    }
    const due = await insertSession(t, f, {
      status: 'completed',
      purgeAfter: 1_000,
    })

    const found = await t.query(internal.purge.sessionsDueForPurge, {
      before: 2_000,
      limit: 25,
    })

    expect(found).toEqual([due])
  })

  it('does not return a session whose clock has not run out yet', async () => {
    await insertSession(t, f, { status: 'completed', purgeAfter: 5_000 })

    const found = await t.query(internal.purge.sessionsDueForPurge, {
      before: 2_000,
      limit: 25,
    })

    expect(found).toEqual([])
  })

  it('stops returning a session once its media has been purged', async () => {
    const sessionId = await insertSession(t, f, {
      status: 'completed',
      purgeAfter: 1_000,
    })

    expect(
      await t.query(internal.purge.sessionsDueForPurge, {
        before: 2_000,
        limit: 25,
      }),
    ).toEqual([sessionId])

    await t.mutation(internal.purge.clearSessionMedia, {
      sessionId,
      candidateEmailHash: 'hash',
      objectsDeleted: 2,
    })

    expect(
      await t.query(internal.purge.sessionsDueForPurge, {
        before: 2_000,
        limit: 25,
      }),
    ).toEqual([])
  })

  it('keeps the retention clock readable after the purge', async () => {
    const sessionId = await insertSession(t, f, {
      status: 'completed',
      purgeAfter: 1_000,
    })
    await t.mutation(internal.purge.clearSessionMedia, {
      sessionId,
      candidateEmailHash: 'hash',
      objectsDeleted: 0,
    })

    const session = await t.run(async (ctx) => ctx.db.get('sessions', sessionId))
    // The clock is what distinguishes "purged on schedule" from "never had a
    // clock". Clearing it would erase the only record of why the media went.
    expect(session?.purgeAfter).toBe(1_000)
    expect(session?.mediaPurgedAt).toEqual(expect.any(Number))
  })
})
