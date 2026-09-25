/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { register as registerAgent } from '@convex-dev/agent/test'
import { createThread } from '@convex-dev/agent'
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

const sent = vi.hoisted(() => [] as Array<{ to: string; subject: string }>)
vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: {
    sendEmail: (_ctx: unknown, email: { to: string; subject: string }) => {
      sent.push({ to: email.to, subject: email.subject })
      return Promise.resolve('provider-id-stub')
    },
  },
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  registerAgent(t, 'agent')
  return t
}
type T = ReturnType<typeof newTest>

type Org = {
  orgId: Id<'organizations'>
  ownerId: Id<'users'>
  logoId: Id<'_storage'>
  tokens: Array<string>
  shareToken: string
  threadId: string
}

/**
 * One organisation with a row in every table erasure has to reach: members
 * of each role, a former member's assistant thread, a restricted role with
 * recorded questions, and `sessions` candidates with recordings, a CV, a
 * transcript, a shared report and the logs around them.
 */
async function seedOrg(
  t: T,
  slug: string,
  { sessions = 2 }: { sessions?: number } = {},
): Promise<Org> {
  return await t.run(async (ctx) => {
    const user = (key: string, language?: 'fr') =>
      ctx.db.insert('users', {
        betterAuthId: `ba_${slug}_${key}`,
        email: `${key}@${slug}.test`,
        name: `${key} ${slug}`,
        superAdmin: false,
        preferredLanguage: language,
        createdAt: 0,
      })
    const ownerId = await user('owner', 'fr')
    const adminId = await user('admin')
    const memberId = await user('member')
    const logoId = await ctx.storage.store(new Blob([`${slug} logo`]))
    const orgId = await ctx.db.insert('organizations', {
      slug,
      name: `${slug[0].toUpperCase()}${slug.slice(1)} Corp`,
      logoStorageId: logoId,
      createdBy: ownerId,
      createdAt: 0,
    })
    for (const [userId, role] of [
      [ownerId, 'owner'],
      [adminId, 'admin'],
      [memberId, 'member'],
    ] as const) {
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role,
        joinedAt: 0,
      })
      await ctx.db.insert('userPrefs', { userId, lastOrgSlug: slug })
    }
    await ctx.db.insert('invitations', {
      orgId,
      email: `invitee@${slug}.test`,
      role: 'member',
      token: `${slug}-invitation-token`,
      invitedBy: ownerId,
      expiresAt: Date.now() + 1e9,
    })

    const projectId = await ctx.db.insert('projects', {
      orgId,
      slug: 'backend',
      title: 'Backend',
      status: 'active',
      language: 'fr',
      introMode: 'video',
      introMediaKey: `orgs/${orgId}/projects/p/intro.webm`,
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: true, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: ownerId,
      createdAt: 0,
      restricted: true,
      sessionCount: sessions,
      completedSessionCount: 0,
    })
    const questionId = await ctx.db.insert('questions', {
      orgId,
      projectId,
      orderIndex: 0,
      content: 'Question 0',
      maxResponseSeconds: 120,
      mediaKey: `orgs/${orgId}/projects/p/q-0.webm`,
      mediaKind: 'video',
    })
    await ctx.db.insert('criteria', {
      orgId,
      projectId,
      label: 'Clarity',
      weight: 100,
      orderIndex: 0,
    })
    await ctx.db.insert('projectShares', {
      orgId,
      projectId,
      userId: memberId,
      grantedBy: ownerId,
      grantedAt: 0,
    })

    const tokens: Array<string> = []
    let shareToken = ''
    let firstSessionId: Id<'sessions'> | null = null
    for (let i = 0; i < sessions; i++) {
      const token = `${slug}${'t'.repeat(30)}${String(i).padStart(4, '0')}`
      tokens.push(token)
      const sessionId = await ctx.db.insert('sessions', {
        orgId,
        projectId,
        accessToken: token,
        candidateName: `Candidate ${i}`,
        candidateEmail: `candidate${i}@example.test`,
        cvKey: `orgs/${orgId}/sessions/s${i}/cv.pdf`,
        status: 'in_progress',
        consentAcceptedAt: 1,
        lastQuestionIndex: 0,
        invitedBy: ownerId,
        invitedAt: 0,
      })
      firstSessionId ??= sessionId
      const segmentId = await ctx.db.insert('segments', {
        orgId,
        sessionId,
        questionId,
        questionIndex: 0,
        videoKey: `orgs/${orgId}/sessions/${sessionId}/q0.webm`,
        audioKey: `orgs/${orgId}/sessions/${sessionId}/q0.weba`,
        supersededKeys: [`orgs/${orgId}/sessions/${sessionId}/q0.mp4`],
        uploadState: 'uploaded',
        uploadAttempts: 1,
        recordedAt: 0,
      })
      await ctx.db.insert('transcripts', {
        orgId,
        sessionId,
        segmentId,
        text: 'An answer.',
        words: [],
        model: 'test',
        createdAt: 0,
      })
      const reportId = await ctx.db.insert('reports', {
        orgId,
        sessionId,
        overallScore: 70,
        recommendation: 'yes',
        executiveSummary: 'Summary.',
        criteriaScores: [],
        strengths: [],
        concerns: [],
        model: 'test',
        generatedAt: 0,
      })
      if (i === 0) {
        shareToken = `${slug}${'s'.repeat(40)}`
        await ctx.db.insert('reportShares', {
          orgId,
          reportId,
          token: shareToken,
          createdBy: ownerId,
          viewCount: 0,
          createdAt: 0,
        })
      }
      await ctx.db.insert('emailLog', {
        orgId,
        template: 'candidate-invitation',
        recipient: `candidate${i}@example.test`,
        status: 'sent',
        sessionId,
        createdAt: 0,
      })
      await ctx.db.insert('jobLog', {
        orgId,
        sessionId,
        step: 'transcribe',
        outcome: 'succeeded',
        attempt: 1,
        at: 0,
      })
      await ctx.db.insert('sessionEvents', {
        orgId,
        sessionId,
        kind: 'recording_started',
        at: 0,
      })
    }
    // Rows that name the organisation and no session.
    await ctx.db.insert('emailLog', {
      orgId,
      template: 'invitation',
      recipient: `invitee@${slug}.test`,
      status: 'sent',
      createdAt: 0,
    })

    // The owner's thread read a candidate; the former member's never did,
    // so no `chatThreadSessions` row points at it.
    const threadId = await createThread(ctx, components.agent, {
      userId: `${orgId}:${ownerId}`,
    })
    await ctx.db.insert('chatThreadSessions', {
      threadId,
      sessionId: firstSessionId!,
    })
    await createThread(ctx, components.agent, {
      userId: `${orgId}:former-member`,
    })

    return { orgId, ownerId, logoId, tokens, shareToken, threadId }
  })
}

const as = (t: T, slug: string, key: string) =>
  t.withIdentity({ subject: `ba_${slug}_${key}` })

/** Every row of every listed table that belongs to the organisation. */
async function rowsOf(t: T, orgId: Id<'organizations'>) {
  return await t.run(async (ctx) => {
    const byOrg = async (
      table:
        | 'organizationMembers'
        | 'invitations'
        | 'projects'
        | 'questions'
        | 'criteria'
        | 'sessions'
        | 'segments'
        | 'transcripts'
        | 'reports'
        | 'reportShares'
        | 'projectShares'
        | 'emailLog'
        | 'jobLog'
        | 'sessionEvents',
    ) =>
      (await ctx.db.query(table).collect()).filter((row) => row.orgId === orgId)
        .length
    const counts: Record<string, number> = {
      organizations: (await ctx.db.get('organizations', orgId)) ? 1 : 0,
    }
    for (const table of [
      'organizationMembers',
      'invitations',
      'projects',
      'questions',
      'criteria',
      'sessions',
      'segments',
      'transcripts',
      'reports',
      'reportShares',
      'projectShares',
      'emailLog',
      'jobLog',
      'sessionEvents',
    ] as const) {
      counts[table] = await byOrg(table)
    }
    return counts
  })
}

/** Every object key the database still names, anywhere. */
async function namedKeys(t: T): Promise<Set<string>> {
  const named = await t.run(async (ctx) => {
    const keys: Array<string> = []
    for (const s of await ctx.db.query('segments').collect()) {
      for (const key of [
        s.videoKey,
        s.audioKey,
        s.thumbnailKey,
        ...(s.supersededKeys ?? []),
      ]) {
        if (key) keys.push(key)
      }
    }
    for (const s of await ctx.db.query('sessions').collect()) {
      if (s.cvKey) keys.push(s.cvKey)
    }
    for (const p of await ctx.db.query('projects').collect()) {
      if (p.introMediaKey) keys.push(p.introMediaKey)
    }
    for (const q of await ctx.db.query('questions').collect()) {
      if (q.mediaKey) keys.push(q.mediaKey)
    }
    return keys
  })
  return new Set(named)
}

async function threadsOf(t: T, scope: string) {
  return await t.run(async (ctx) =>
    ctx.runQuery(components.agent.threads.listThreadsByUserId, {
      userId: scope,
    }),
  )
}

describe('deleting an organisation', () => {
  let t: T
  let a: Org
  let b: Org

  beforeEach(async () => {
    vi.useFakeTimers()
    vi.stubEnv('PURGE_HASH_SALT', 'test-salt')
    sent.length = 0
    t = newTest()
    a = await seedOrg(t, 'acme')
    b = await seedOrg(t, 'rival')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  const request = (slug = 'acme', key = 'owner', confirmName = 'Acme Corp') =>
    as(t, slug, key).mutation(api.organizations.requestDeletion, {
      orgId: a.orgId,
      confirmName,
    })

  async function eraseAll(): Promise<Array<Array<string>>> {
    const calls: Array<Array<string>> = []
    vi.spyOn(
      await import('./lib/objectStore'),
      'deleteObjects',
    ).mockImplementation(async (keys: Array<string>) => {
      // Objects before rows: whatever is deleted here must still be named
      // by a row at the moment it goes.
      const named = await namedKeys(t)
      for (const key of keys) expect(named.has(key), key).toBe(true)
      calls.push(keys)
    })
    await request()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    return calls
  }

  it('is for owners only', async () => {
    await expect(request('acme', 'admin')).rejects.toThrow('insufficient_role')
    await expect(request('acme', 'member')).rejects.toThrow('insufficient_role')
    // Owner of another organisation: not a member of this one at all.
    await expect(request('rival', 'owner', 'Acme Corp')).rejects.toThrow(
      'not_a_member',
    )
    const org = await t.run((ctx) => ctx.db.get('organizations', a.orgId))
    expect(org!.deletingAt).toBeUndefined()
    expect(sent).toEqual([])
  })

  it('asks for the exact name', async () => {
    await expect(request('acme', 'owner', 'acme corp')).rejects.toThrow(
      'confirm_mismatch',
    )
    await expect(request('acme', 'owner', '  Acme Corp  ')).resolves.toBeNull()
  })

  it('tells every member once, and schedules one erasure', async () => {
    await request()
    expect(sent.map((email) => email.to).sort()).toEqual([
      'admin@acme.test',
      'member@acme.test',
      'owner@acme.test',
    ])
    // The owner reads French; the others have no preference.
    expect(sent.find((e) => e.to === 'owner@acme.test')!.subject).toBe(
      'Acme Corp a été supprimée sur interw',
    )

    // A second request changes nothing: the freeze refuses it.
    await expect(request()).rejects.toThrow('org_deleting')
    expect(sent).toHaveLength(3)
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query('_scheduled_functions').collect(),
    )
    expect(scheduled.filter((job) => job.name.includes('orgErasure'))).toHaveLength(1)
  })

  it('freezes the organisation before anything is erased', async () => {
    await request()

    await expect(
      as(t, 'acme', 'owner').query(api.organizations.listMembers, {
        orgId: a.orgId,
      }),
    ).rejects.toThrow('org_deleting')
    const me = await as(t, 'acme', 'member').query(api.users.me, {})
    expect(me.kind === 'ready' && me.orgs).toEqual([])
    expect(
      await as(t, 'acme', 'owner').query(api.organizations.bySlug, {
        slug: 'acme',
      }),
    ).toBeNull()

    // No upload can be reserved once the keys are about to be collected.
    await expect(
      t.mutation(internal.interview.reserveSegment, {
        token: a.tokens[0],
        questionIndex: 0,
        audio: { mimeType: 'audio/webm', contentLength: 1024 },
      }),
    ).rejects.toThrow('closed')
    expect(
      await t.query(api.shares.view, { token: a.shareToken, now: Date.now() }),
    ).toEqual({ state: 'not_found', report: null })

    // The other organisation carries on.
    await expect(
      as(t, 'rival', 'owner').query(api.organizations.listMembers, {
        orgId: b.orgId,
      }),
    ).resolves.toHaveLength(3)
    expect(
      (await t.query(api.shares.view, { token: b.shareToken, now: Date.now() }))
        .state,
    ).toBe('active')
  })

  it('erases every row and object of the organisation, and nothing else', async () => {
    const rivalBefore = await rowsOf(t, b.orgId)
    const rivalKeys = [...(await namedKeys(t))].filter((key) =>
      key.startsWith(`orgs/${b.orgId}/`),
    )
    const acmeKeys = [...(await namedKeys(t))].filter((key) =>
      key.startsWith(`orgs/${a.orgId}/`),
    )

    const calls = await eraseAll()

    const acme = await rowsOf(t, a.orgId)
    expect(Object.values(acme).every((count) => count === 0), JSON.stringify(acme)).toBe(true)
    expect(await rowsOf(t, b.orgId)).toEqual(rivalBefore)

    expect(calls.flat().sort()).toEqual(acmeKeys.sort())
    expect(await namedKeys(t)).toEqual(new Set(rivalKeys))

    await t.run(async (ctx) => {
      // The register survives the organisation it names.
      const register = (await ctx.db.query('purgeLog').collect()).filter(
        (row) => row.orgId === a.orgId,
      )
      expect(register).toHaveLength(2)
      expect(register.every((row) => row.reason === 'org_delete')).toBe(true)
      const reads = await ctx.db.query('chatThreadSessions').collect()
      expect(reads.map((read) => read.threadId)).toEqual([b.threadId])

      expect(await ctx.storage.get(a.logoId)).toBeNull()
      expect(await ctx.storage.get(b.logoId)).not.toBeNull()

      const prefs = await ctx.db.query('userPrefs').collect()
      expect(prefs.filter((p) => p.lastOrgSlug === 'acme')).toEqual([])
      expect(prefs.filter((p) => p.lastOrgSlug === 'rival')).toHaveLength(3)
    })
  })

  it('deletes every assistant thread scoped to the organisation', async () => {
    const rivalThread = await threadsOf(t, `${b.orgId}:${b.ownerId}`)
    expect(rivalThread.page).toHaveLength(1)

    await eraseAll()

    expect((await threadsOf(t, `${a.orgId}:${a.ownerId}`)).page).toEqual([])
    // Never read a candidate, so only the organisation pass could find it.
    expect((await threadsOf(t, `${a.orgId}:former-member`)).page).toEqual([])
    expect((await threadsOf(t, `${b.orgId}:${b.ownerId}`)).page).toEqual(
      rivalThread.page,
    )
  })

  it('erases a large organisation in several bounded passes', async () => {
    t = newTest()
    a = await seedOrg(t, 'acme', { sessions: 60 })
    const log = vi.spyOn(console, 'log')

    await eraseAll()

    const sessionPasses = log.mock.calls.filter(
      ([event, data]) =>
        event === '[org-erasure]' &&
        (data as { phase: string }).phase === 'sessions',
    )
    // 25 + 25 + 10, then the pass that finds none.
    expect(sessionPasses.map(([, data]) => (data as { count: number }).count)).toEqual([
      25, 25, 10, 0,
    ])
    expect((await rowsOf(t, a.orgId)).sessions).toBe(0)
    const register = await t.run((ctx) => ctx.db.query('purgeLog').collect())
    expect(register).toHaveLength(60)
  })

  it('retries a pass that failed, and a finished erasure is a no-op', async () => {
    let failures = 1
    const deleted: Array<string> = []
    vi.spyOn(
      await import('./lib/objectStore'),
      'deleteObjects',
    ).mockImplementation((keys: Array<string>) => {
      if (keys.length > 0 && failures-- > 0) {
        return Promise.reject(new Error('bucket unavailable'))
      }
      deleted.push(...keys)
      return Promise.resolve()
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await request()
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await rowsOf(t, a.orgId)).organizations).toBe(0)
    const count = deleted.length

    await t.action(internal.orgErasure.step, { orgId: a.orgId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect(deleted).toHaveLength(count)
  })

  it('never erases an organisation nobody asked to delete', async () => {
    await t.action(internal.orgErasure.step, { orgId: a.orgId })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    expect((await rowsOf(t, a.orgId)).sessions).toBe(2)
  })

  it('frees its sole owner to delete their account', async () => {
    const asOwner = as(t, 'acme', 'owner')
    expect(
      (await asOwner.query(api.users.accountDeletionBlockers, {})).soleOwnedOrgs,
    ).toHaveLength(1)

    await eraseAll()

    expect(
      (await asOwner.query(api.users.accountDeletionBlockers, {})).soleOwnedOrgs,
    ).toEqual([])
    await t.mutation(internal.users.cascadeDelete, {
      betterAuthId: 'ba_acme_owner',
    })
    expect(await t.run((ctx) => ctx.db.get('users', a.ownerId))).toBeNull()
  })
})
