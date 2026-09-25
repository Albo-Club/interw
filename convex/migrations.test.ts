/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerAgent } from '@convex-dev/agent/test'
import { createThread, saveMessage } from '@convex-dev/agent'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { components, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

const NAME = 'purgeLegacyAssistantThreads'
const HOUR = 60 * 60 * 1000
const CUTOFF = Date.UTC(2026, 8, 25, 9)

function newTest() {
  const t = convexTest(schema, modules)
  registerAgent(t, 'agent')
  return t
}

/** An organisation with one member, and `sessions` candidates to read. */
async function seed(t: ReturnType<typeof newTest>, sessions: number) {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_recruiter',
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
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId,
      role: 'owner',
      joinedAt: 0,
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
      sessionCount: sessions,
      completedSessionCount: 0,
    })
    const sessionIds: Array<Id<'sessions'>> = []
    for (let i = 0; i < sessions; i++) {
      sessionIds.push(
        await ctx.db.insert('sessions', {
          orgId,
          projectId,
          accessToken: String(i).padStart(43, 'x'),
          candidateName: `Candidate ${i}`,
          candidateEmail: `c${i}@example.test`,
          status: 'pending',
          lastQuestionIndex: 0,
          invitedBy: userId,
          invitedAt: 0,
        }),
      )
    }
    return { orgId, userId, sessionIds }
  })
}

/**
 * Threads from before erasure tracking carry no `chatThreadSessions` row, so
 * erasing a candidate cannot find the ones that read them. The owner chose to
 * delete them all, once, on every deployment, without anyone running a thing.
 */
describe('migrations.purgeLegacyAssistantThreads', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(CUTOFF - HOUR)
    t = newTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** One cron tick, and everything it sets in motion. */
  async function tick(at: number) {
    vi.setSystemTime(at)
    await t.mutation(internal.migrations.purgeLegacyAssistantThreads, {})
    await t.finishAllScheduledFunctions(vi.runAllTimers)
  }

  async function newThread(scope: string, reads: Array<Id<'sessions'>> = []) {
    return await t.run(async (ctx) => {
      const threadId = await createThread(ctx, components.agent, {
        userId: scope,
      })
      await saveMessage(ctx, components.agent, {
        threadId,
        message: { role: 'assistant', content: 'Candidate 0: strong delivery.' },
      })
      for (const sessionId of reads) {
        await ctx.db.insert('chatThreadSessions', { threadId, sessionId })
      }
      return threadId
    })
  }

  async function surviving(threadIds: Array<string>) {
    return await t.run(async (ctx) => {
      const kept = []
      for (const threadId of threadIds) {
        const thread = await ctx.runQuery(components.agent.threads.getThread, {
          threadId,
        })
        if (thread) kept.push(threadId)
      }
      return kept
    })
  }

  const readRows = () =>
    t.run(async (ctx) => ctx.db.query('chatThreadSessions').collect())

  const migration = () =>
    t.run(async (ctx) =>
      ctx.db
        .query('migrations')
        .withIndex('by_name', (q) => q.eq('name', NAME))
        .unique(),
    )

  it('deletes every thread from before its first run, in every scope, and keeps the rest', async () => {
    const { orgId, userId, sessionIds } = await seed(t, 1)
    const legacy = [
      await newThread(`${orgId}:${userId}`, sessionIds),
      await newThread(`${orgId}:${userId}`),
      // A member since removed: no membership names this scope any more.
      await newThread(`${orgId}:removed-user`),
      // An organisation that no longer exists at all.
      await newThread('gone-org:gone-user'),
    ]

    await tick(CUTOFF)
    expect((await migration())?.cutoff).toBe(CUTOFF)
    expect(await surviving(legacy)).toEqual([])
    expect(await readRows()).toEqual([])
    // It found something, so it is not done: the next tick checks again.
    expect((await migration())?.doneAt).toBeUndefined()

    vi.setSystemTime(CUTOFF + HOUR)
    const recent = await newThread(`${orgId}:${userId}`, sessionIds)
    await tick(CUTOFF + 2 * HOUR)
    expect((await migration())?.doneAt).toBe(CUTOFF + 2 * HOUR)
    expect(await surviving([recent])).toEqual([recent])
    expect(await readRows()).toHaveLength(1)
  })

  it('does nothing once done, even on a thread from before the cutoff', async () => {
    const { orgId, userId } = await seed(t, 0)
    await tick(CUTOFF)
    const done = await migration()
    expect(done?.doneAt).toBe(CUTOFF)

    vi.setSystemTime(CUTOFF - HOUR)
    const late = await newThread(`${orgId}:${userId}`)
    await tick(CUTOFF + HOUR)
    expect(await migration()).toEqual(done)
    expect(await surviving([late])).toEqual([late])
    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query('_scheduled_functions').collect(),
    )
    expect(scheduled.filter((job) => job.name.includes('migrations'))).toHaveLength(0)
  })

  it('works through more threads and rows than one step takes', async () => {
    // 60 threads of 11 reads each: more threads than one batch of 50, and
    // more rows (550) in that batch than the 500 one step deletes.
    const { orgId, userId, sessionIds } = await seed(t, 11)
    const legacy = []
    for (let i = 0; i < 60; i++) {
      legacy.push(await newThread(`${orgId}:${userId}`, sessionIds))
    }
    legacy.push(await newThread(`${orgId}:other-user`))

    await tick(CUTOFF)
    expect(await surviving(legacy)).toEqual([])
    expect(await readRows()).toEqual([])

    await tick(CUTOFF + HOUR)
    expect((await migration())?.doneAt).toBe(CUTOFF + HOUR)
  })
})
