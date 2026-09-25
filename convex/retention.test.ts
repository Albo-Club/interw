/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/** An object the store refuses to delete, whatever the pass. */
const STUCK_KEY = 'orgs/o/sessions/stuck/cv.pdf'

vi.mock('./lib/objectStore', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deleteObjects: (keys: Array<string>) =>
    keys.includes(STUCK_KEY)
      ? Promise.reject(new Error('object store refused delete: HTTP 403'))
      : Promise.resolve(),
}))

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

async function dueSession(
  t: ReturnType<typeof newTest>,
  f: Fixture,
  n: number,
  cvKey: string,
): Promise<Id<'sessions'>> {
  return await t.run(async (ctx) =>
    ctx.db.insert('sessions', {
      orgId: f.orgId,
      projectId: f.projectId,
      accessToken: String(n).padStart(43, 'a'),
      candidateName: `Candidate ${n}`,
      candidateEmail: `c${n}@example.test`,
      status: 'completed',
      lastQuestionIndex: 0,
      invitedBy: f.userId,
      invitedAt: 0,
      cvKey,
      // Ascending, so the stuck one sits at the head of the index.
      purgeAfter: n,
    }),
  )
}

/**
 * Audit 2026-09-15, Pipe M7; audit 2026-09-22, h09.
 *
 * One object the store would not delete aborted the whole pass, and because
 * the due range is read in index order, the same session came back first on
 * every pass after — retention stopped for the whole deployment, silently.
 */
describe('the retention purge', () => {
  let t: ReturnType<typeof newTest>
  let f: Fixture

  beforeEach(async () => {
    vi.stubEnv('PURGE_HASH_SALT', 'test-salt')
    t = newTest()
    f = await seed(t)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('purges the next session when the first one fails', async () => {
    const stuck = await dueSession(t, f, 1, STUCK_KEY)
    const fine = await dueSession(t, f, 2, 'orgs/o/sessions/fine/cv.pdf')

    const result = await t.action(internal.retention.purgeDueSessions, {})

    expect(result).toEqual({ purged: 1, failed: 1 })
    const { stuckRow, fineRow, log } = await t.run(async (ctx) => ({
      stuckRow: await ctx.db.get('sessions', stuck),
      fineRow: await ctx.db.get('sessions', fine),
      log: await ctx.db
        .query('jobLog')
        .withIndex('by_session', (q) => q.eq('sessionId', stuck))
        .collect(),
    }))
    expect(fineRow?.mediaPurgedAt).toEqual(expect.any(Number))
    expect(stuckRow?.mediaPurgedAt).toBeUndefined()
    // The failure is written down where the rest of the session's history is.
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ step: 'purge', outcome: 'failed' })
    expect(log[0].error).toContain('HTTP 403')
  })

  it('does not put a failed session back at the head of the next pass', async () => {
    await dueSession(t, f, 1, STUCK_KEY)
    const fine = await dueSession(t, f, 2, 'orgs/o/sessions/fine/cv.pdf')

    // One session per pass: before, the stuck one filled every batch.
    await t.action(internal.retention.purgeDueSessions, { limit: 1 })
    await t.action(internal.retention.purgeDueSessions, { limit: 1 })

    const fineRow = await t.run(async (ctx) => ctx.db.get('sessions', fine))
    expect(fineRow?.mediaPurgedAt).toEqual(expect.any(Number))
  })
})
