/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { register as registerAgent } from '@convex-dev/agent/test'
import { createThread, listMessages, saveMessage } from '@convex-dev/agent'
import { ConvexError } from 'convex/values'
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

const CANDIDATE_EMAIL = 'alex@example.test'
const TOKEN = 'e'.repeat(43)

type Seed = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  sessionId: Id<'sessions'>
}

async function seed(
  t: ReturnType<typeof newTest>,
  { sessionEvents = 0 }: { sessionEvents?: number } = {},
): Promise<Seed> {
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
      introMode: 'video',
      introMediaKey: 'orgs/o/projects/p/intro.webm',
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
      completedSessionCount: 1,
    })
    await ctx.db.insert('questions', {
      orgId,
      projectId,
      orderIndex: 0,
      content: 'Question 0',
      maxResponseSeconds: 120,
      mediaKey: 'orgs/o/projects/p/q0.webm',
      mediaKind: 'video',
    })
    const sessionId = await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: TOKEN,
      candidateName: 'Alex Martin',
      candidateEmail: CANDIDATE_EMAIL,
      status: 'completed',
      consentAcceptedAt: 1,
      lastQuestionIndex: 1,
      invitedBy: userId,
      invitedAt: 0,
      completedAt: 1,
    })
    await ctx.db.insert('emailLog', {
      orgId,
      template: 'candidate-invitation',
      recipient: CANDIDATE_EMAIL,
      status: 'sent',
      sessionId,
      createdAt: 0,
    })
    for (let i = 0; i < sessionEvents; i++) {
      await ctx.db.insert('sessionEvents', {
        orgId,
        sessionId,
        kind: 'upload_retried',
        at: i,
      })
    }
    return { orgId, projectId, sessionId }
  })
}

async function erase(
  t: ReturnType<typeof newTest>,
  sessionId: Id<'sessions'>,
): Promise<void> {
  await t.mutation(internal.purge.deleteSessionRecords, {
    sessionId,
    reason: 'candidate_request',
    candidateEmailHash: 'hash',
    objectsDeleted: 0,
  })
  await t.finishAllScheduledFunctions(vi.runAllTimers)
}

describe('erasure', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('PURGE_HASH_SALT', 'test-salt')
    t = newTest()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  /**
   * `purgeLog` took care to store only a hash of the address. Three tables
   * away, `emailLog` kept it in clear text, indexed by recipient and readable
   * by every member of the organisation through the deliverability screen.
   */
  it('takes the candidate address out of emailLog too', async () => {
    const s = await seed(t)
    await erase(t, s.sessionId)

    const remaining = await t.run(async (ctx) =>
      ctx.db
        .query('emailLog')
        .withIndex('by_recipient', (q) => q.eq('recipient', CANDIDATE_EMAIL))
        .collect(),
    )
    expect(remaining).toEqual([])
  })

  /**
   * `sessionEvents` is written by the candidate's own browser, so the number
   * of rows to delete was theirs to choose. One transaction over the limit and
   * erasure failed — after the recordings were already deleted, leaving a
   * session that could never be erased and a button that would never work.
   *
   * `convex-test` does not enforce Convex's per-transaction document limits,
   * so it cannot reproduce that failure. What it can hold is the property that
   * replaces it: one pass deletes a bounded number of rows and hands the rest
   * on, and the session row — with the register entry — goes last.
   */
  it('deletes in bounded passes and leaves the session row until the end', async () => {
    const s = await seed(t, { sessionEvents: 450 })

    // One pass, without draining the scheduler.
    await t.mutation(internal.purge.deleteSessionRecords, {
      sessionId: s.sessionId,
      reason: 'candidate_request',
      candidateEmailHash: 'hash',
      objectsDeleted: 0,
    })

    const { session, events, log } = await t.run(async (ctx) => ({
      session: await ctx.db.get('sessions', s.sessionId),
      events: await ctx.db
        .query('sessionEvents')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
      log: await ctx.db.query('purgeLog').collect(),
    }))

    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThan(450)
    // Still there, so an erasure that stops half-way is visibly unfinished
    // rather than a register entry claiming a finished one.
    expect(session).not.toBeNull()
    expect(log).toEqual([])
  })

  it('erases a session with more rows than one transaction can carry', async () => {
    const s = await seed(t, { sessionEvents: 450 })
    await erase(t, s.sessionId)

    const { session, events, log } = await t.run(async (ctx) => ({
      session: await ctx.db.get('sessions', s.sessionId),
      events: await ctx.db
        .query('sessionEvents')
        .withIndex('by_session', (q) => q.eq('sessionId', s.sessionId))
        .collect(),
      log: await ctx.db.query('purgeLog').collect(),
    }))

    expect(session).toBeNull()
    expect(events).toEqual([])
    // Exactly one register entry, written by the pass that removed the row.
    expect(log).toHaveLength(1)
  })

  /**
   * A tool result is a copy of the candidate — name, summary, strengths,
   * concerns — held in the agent component, and so is the answer the model
   * wrote from it. Erasure used to stop at the app's tables and leave both in
   * the recruiter's chat history for good.
   */
  it('deletes the assistant threads that read the candidate', async () => {
    const s = await seed(t)
    const { userId, readThread, otherThread } = await t.run(async (ctx) => {
      const user = await ctx.db.query('users').first()
      const scope = `${s.orgId}:${user!._id}`
      const read = await createThread(ctx, components.agent, { userId: scope })
      await saveMessage(ctx, components.agent, {
        threadId: read,
        message: { role: 'assistant', content: 'Alex Martin: strong delivery.' },
      })
      const other = await createThread(ctx, components.agent, { userId: scope })
      return { userId: user!._id, readThread: read, otherThread: other }
    })

    const args = { orgId: s.orgId, actorUserId: userId, threadId: readThread }
    await t.mutation(internal.recruiterTools.listCandidatesInternal, args)
    await t.mutation(internal.recruiterTools.readReportInternal, {
      ...args,
      sessionId: s.sessionId,
    })
    const recorded = await t.run(async (ctx) =>
      ctx.db.query('chatThreadSessions').collect(),
    )
    // Two reads of the same candidate into the same thread: one row.
    expect(recorded).toHaveLength(1)

    await erase(t, s.sessionId)

    const after = await t.run(async (ctx) => ({
      read: await ctx.runQuery(components.agent.threads.getThread, {
        threadId: readThread,
      }),
      readMessages: await listMessages(ctx, components.agent, {
        threadId: readThread,
        paginationOpts: { numItems: 10, cursor: null },
      }),
      other: await ctx.runQuery(components.agent.threads.getThread, {
        threadId: otherThread,
      }),
      rows: await ctx.db.query('chatThreadSessions').collect(),
    }))
    expect(after.read).toBeNull()
    expect(after.readMessages.page).toEqual([])
    // A thread that never read the candidate is the recruiter's, untouched.
    expect(after.other).not.toBeNull()
    expect(after.rows).toEqual([])
  })

  /**
   * The recruiter may have that thread open when it goes. `listMessages` used
   * to throw on a missing thread, and the panel rendering it has no error
   * boundary of its own, so the whole app shell fell to the router's fallback.
   */
  it('reads an erased thread as empty, and a foreign one as forbidden', async () => {
    const s = await seed(t)
    const { gone, foreign } = await t.run(async (ctx) => {
      const user = await ctx.db.query('users').first()
      const own = await createThread(ctx, components.agent, {
        userId: `${s.orgId}:${user!._id}`,
      })
      await ctx.runMutation(components.agent.threads.deleteAllForThreadIdAsync, {
        threadId: own,
      })
      return {
        gone: own,
        foreign: await createThread(ctx, components.agent, {
          userId: `${s.orgId}:someone-else`,
        }),
      }
    })
    const recruiter = t.withIdentity({ subject: 'ba_recruiter' })
    const read = (threadId: string) =>
      recruiter.query(api.chat.listMessages, {
        orgId: s.orgId,
        threadId,
        paginationOpts: { numItems: 10, cursor: null },
        streamArgs: { kind: 'list' },
      })

    await expect(read(gone)).resolves.toEqual({
      page: [],
      isDone: true,
      continueCursor: '',
      streams: { kind: 'list', messages: [] },
    })
    await expect(read(foreign)).rejects.toThrow(/forbidden/)
  })

  it('refuses to write the register without a salt', async () => {
    vi.stubEnv('PURGE_HASH_SALT', '')
    await expect(
      t.query(internal.purge.collectSessionObjects, {
        sessionId: (await seed(t)).sessionId,
      }),
    ).resolves.not.toBeNull()

    const { hashEmail } = await import('./purge')
    await expect(hashEmail(CANDIDATE_EMAIL)).rejects.toThrow(ConvexError)
  })

  it('salts the register hash', async () => {
    const { hashEmail } = await import('./purge')
    const salted = await hashEmail(CANDIDATE_EMAIL)
    vi.stubEnv('PURGE_HASH_SALT', 'another-salt')
    expect(await hashEmail(CANDIDATE_EMAIL)).not.toBe(salted)
  })
})

/**
 * The recruiter's own recordings are personal data as well. Deleting only the
 * rows left them in the bucket, unreachable by any later purge and removable
 * only by inspecting the bucket by hand.
 */
describe('deleting a role', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(() => {
    vi.useFakeTimers()
    t = newTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('schedules the intro and question media for deletion', async () => {
    const s = await seed(t)
    await t.run(async (ctx) => {
      await ctx.db.delete('sessions', s.sessionId)
      await ctx.db.patch('projects', s.projectId, {
        sessionCount: 0,
        completedSessionCount: 0,
      })
    })

    const deleted: Array<Array<string>> = []
    const spy = vi
      .spyOn(await import('./lib/objectStore'), 'deleteObjects')
      .mockImplementation((keys: Array<string>) => {
        deleted.push(keys)
        return Promise.resolve()
      })

    await t
      .withIdentity({ subject: 'ba_recruiter' })
      .mutation(api.projects.remove, { projectId: s.projectId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)

    expect(deleted.flat().sort()).toEqual([
      'orgs/o/projects/p/intro.webm',
      'orgs/o/projects/p/q0.webm',
    ])
    spy.mockRestore()
  })
})
