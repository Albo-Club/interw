/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import { projectMediaKey } from './lib/objectStore'
import schema from './schema'
import type { Id } from './_generated/dataModel'

/** Stands in for Better Auth's "who is calling"; see guards.test.ts. */
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

vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: { sendEmail: () => Promise.resolve('provider-id-stub') },
}))

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

type World = {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  questionId: Id<'questions'>
  token: string
}

const TOKEN = 'm'.repeat(43)

async function seed(t: ReturnType<typeof newTest>): Promise<World> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_owner',
      email: 'owner@example.test',
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
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: userId,
      createdAt: 0,
      sessionCount: 1,
      completedSessionCount: 0,
    })
    await ctx.db.patch('projects', projectId, {
      introMediaKey: projectMediaKey(orgId, projectId, 'intro', 'webm'),
    })
    const questionId = await ctx.db.insert('questions', {
      orgId,
      projectId,
      orderIndex: 0,
      content: 'Tell me about a migration you led.',
      maxResponseSeconds: 120,
    })
    await ctx.db.insert('sessions', {
      orgId,
      projectId,
      accessToken: TOKEN,
      candidateName: 'Alex Martin',
      candidateEmail: 'alex@example.test',
      status: 'pending',
      consentAcceptedAt: 1,
      lastQuestionIndex: 0,
      invitedBy: userId,
      invitedAt: 0,
    })
    return { orgId, projectId, questionId, token: TOKEN }
  })
}

const owner = (t: ReturnType<typeof newTest>) =>
  t.withIdentity({ subject: 'ba_owner' })

/**
 * Pipe F6 (audit 2026-09-15): the attach step checked a prefix, so a made-up
 * key under the slot — `intro.zzz` — was accepted, and the object it replaced
 * was deleted. Only a key an upload slot could have issued is accepted now.
 */
describe('attaching a recording', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  const introKey = (extension: string) =>
    projectMediaKey(w.orgId, w.projectId, 'intro', extension)
  const questionKey = (extension: string) =>
    projectMediaKey(w.orgId, w.projectId, `q-${w.questionId}`, extension)

  it('refuses an intro key no upload slot issues, and keeps the current one', async () => {
    for (const key of [
      introKey('zzz'),
      `${introKey('webm')}.bak`,
      // An audio take is not an intro: the intro is filmed.
      introKey('weba'),
    ]) {
      await expect(
        owner(t).mutation(internal.media.swapIntroKey, {
          projectId: w.projectId,
          key,
        }),
      ).rejects.toThrow('key_mismatch')
    }
    const project = await t.run((ctx) => ctx.db.get('projects', w.projectId))
    expect(project?.introMediaKey).toBe(introKey('webm'))
  })

  it('accepts the intro key a video slot issues, and names the one it replaces', async () => {
    const result = await owner(t).mutation(internal.media.swapIntroKey, {
      projectId: w.projectId,
      key: introKey('mp4'),
    })
    expect(result.previous).toBe(introKey('webm'))
  })

  it('refuses a question key no upload slot issues', async () => {
    for (const key of [questionKey('zzz'), `${questionKey('webm')}x`]) {
      await expect(
        owner(t).mutation(internal.media.swapQuestionKey, {
          questionId: w.questionId,
          key,
        }),
      ).rejects.toThrow('key_mismatch')
    }
  })

  // Cand F2: the kind decides <audio> or <video>, so it is read off the key
  // the server issued rather than taken from the client.
  it('reads the prompt kind off the key', async () => {
    await owner(t).mutation(internal.media.swapQuestionKey, {
      questionId: w.questionId,
      key: questionKey('m4a'),
    })
    let question = await t.run((ctx) => ctx.db.get('questions', w.questionId))
    expect(question?.mediaKind).toBe('audio')

    await owner(t).mutation(internal.media.swapQuestionKey, {
      questionId: w.questionId,
      key: questionKey('mp4'),
    })
    question = await t.run((ctx) => ctx.db.get('questions', w.questionId))
    expect(question?.mediaKind).toBe('video')
  })
})

/** Decision n° 1 (T05): the intro is a video the recruiter films, or nothing. */
describe('the intro is a video or nothing', () => {
  let t: ReturnType<typeof newTest>
  let w: World

  beforeEach(async () => {
    t = newTest()
    w = await seed(t)
  })

  it('issues no intro upload slot for audio alone', async () => {
    await expect(
      owner(t).query(internal.media.resolveIntroUpload, {
        projectId: w.projectId,
        mimeType: 'audio/webm;codecs=opus',
        contentLength: 1_000,
      }),
    ).rejects.toThrow('unsupported_media_type')
    const slot = await owner(t).query(internal.media.resolveIntroUpload, {
      projectId: w.projectId,
      mimeType: 'video/mp4',
      contentLength: 1_000,
    })
    expect(slot.key).toBe(
      projectMediaKey(w.orgId, w.projectId, 'intro', 'mp4'),
    )
  })

  it('refuses the retired text and audio modes', async () => {
    for (const introMode of ['text', 'audio']) {
      await expect(
        owner(t).mutation(api.projects.update, {
          projectId: w.projectId,
          introMode: introMode as 'video',
        }),
      ).rejects.toThrow()
    }
    await owner(t).mutation(api.projects.update, {
      projectId: w.projectId,
      introMode: 'none',
    })
    const project = await t.run((ctx) => ctx.db.get('projects', w.projectId))
    expect(project?.introMode).toBe('none')
  })

  it('signs no intro for a candidate once the intro is switched off', async () => {
    const shown = await t.query(internal.interview.resolvePromptMedia, {
      token: w.token,
      now: Date.now(),
    })
    expect(shown.introKey).toBe(
      projectMediaKey(w.orgId, w.projectId, 'intro', 'webm'),
    )

    for (const introMode of ['none', 'audio'] as const) {
      await t.run((ctx) => ctx.db.patch('projects', w.projectId, { introMode }))
      const hidden = await t.query(internal.interview.resolvePromptMedia, {
        token: w.token,
        now: Date.now(),
      })
      expect(hidden.introKey).toBeNull()
      const view = await t.query(api.interview.questions, {
        token: w.token,
        now: Date.now(),
      })
      expect(view.introMode).toBe('none')
    }
  })
})

/**
 * E7 (audit 2026-09-15, recruiter): a recorded question could not be played
 * back. The wizard now plays each recording from `playbackUrls`, which says
 * what kind each one is so an audio prompt lands in <audio>.
 */
describe('playing a role’s recordings back', () => {
  beforeEach(() => {
    vi.stubEnv('OBJECT_STORE_ENDPOINT', 'https://s3.example.test')
    vi.stubEnv('OBJECT_STORE_REGION', 'fr-par')
    vi.stubEnv('OBJECT_STORE_BUCKET', 'media')
    vi.stubEnv('OBJECT_STORE_ACCESS_KEY_ID', 'test-access-key')
    vi.stubEnv('OBJECT_STORE_SECRET_ACCESS_KEY', 'test-secret-key')
  })

  it('signs the intro and each prompt, with its kind', async () => {
    const t = newTest()
    const w = await seed(t)
    await owner(t).mutation(internal.media.swapQuestionKey, {
      questionId: w.questionId,
      key: projectMediaKey(w.orgId, w.projectId, `q-${w.questionId}`, 'm4a'),
    })
    const playback = await owner(t).action(api.media.playbackUrls, {
      projectId: w.projectId,
    })
    expect(playback.intro).toContain('/intro.webm')
    expect(playback.questions).toEqual([
      {
        questionId: w.questionId,
        url: expect.stringContaining(`/q-${w.questionId}.m4a`),
        kind: 'audio',
      },
    ])
  })
})

/**
 * The one-off rewrite of roles still on a retired mode. Written and tested,
 * not run by any deploy: until it runs, those roles already read as `none`.
 */
describe('migrateLegacyIntroModes', () => {
  it('moves text and audio intros to none, and releases an audio object', async () => {
    const t = newTest()
    const w = await seed(t)
    const audioKey = projectMediaKey(w.orgId, w.projectId, 'intro', 'weba')
    const [textId, audioId] = await t.run(async (ctx) => {
      const base = await ctx.db.get('projects', w.projectId)
      if (!base) throw new Error('seed')
      const { _id: _unusedId, _creationTime: _unusedTime, ...fields } = base
      const text = await ctx.db.insert('projects', {
        ...fields,
        slug: 'text',
        introMode: 'text',
        introText: 'Bienvenue',
        introMediaKey: undefined,
      })
      const audio = await ctx.db.insert('projects', {
        ...fields,
        slug: 'audio',
        introMode: 'audio',
        introMediaKey: audioKey,
      })
      return [text, audio]
    })

    const result = await t.mutation(internal.media.migrateLegacyIntroModes, {})
    expect(result).toEqual({ migrated: 2, done: true })

    const rows = await t.run(async (ctx) => ({
      video: await ctx.db.get('projects', w.projectId),
      text: await ctx.db.get('projects', textId),
      audio: await ctx.db.get('projects', audioId),
      scheduled: await ctx.db.system.query('_scheduled_functions').collect(),
    }))
    expect(rows.video?.introMode).toBe('video')
    expect(rows.video?.introMediaKey).toBeDefined()
    expect(rows.text?.introMode).toBe('none')
    expect(rows.audio?.introMode).toBe('none')
    expect(rows.audio?.introMediaKey).toBeUndefined()
    expect(rows.scheduled.map((job) => job.args[0])).toEqual([
      { keys: [audioKey] },
    ])

    // A second pass finds nothing left to do.
    expect(
      await t.mutation(internal.media.migrateLegacyIntroModes, {}),
    ).toEqual({ migrated: 0, done: true })
  })
})
