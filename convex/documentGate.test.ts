/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { ConvexError } from 'convex/values'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

const TOKEN = 'c'.repeat(43)
const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

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
 * `attachDocument` deletes the object it replaced. `reserveDocumentUpload`
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
      mimeType: DOCX,
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
        mimeType: DOCX,
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
        mimeType: DOCX,
      }),
    ).rejects.toThrow(ConvexError)
  })

  it('refuses a document the role never asked for', async () => {
    await expect(
      t.mutation(internal.candidate.swapDocumentKey, {
        token: TOKEN,
        kind: 'cover',
        mimeType: 'application/pdf',
      }),
    ).rejects.toThrow(ConvexError)
  })

  /**
   * h01/h04/h09. The client used to hand back the key it was issued, and the
   * check was `startsWith(prefix)`: `cv.zzz` or `cv.pdf/../x` passed, the row
   * pointed at an object that does not exist, and the CV it replaced was
   * deleted. The key is now derived from the type, so only the three names an
   * upload slot can issue are reachable at all.
   */
  it('derives the key from the document type, and only an accepted one', async () => {
    const result = await t.mutation(internal.candidate.swapDocumentKey, {
      token: TOKEN,
      kind: 'cv',
      mimeType: `${DOCX}; charset=binary`,
    })
    expect(result.previous).toBe(keyFor(s, 'cv.pdf'))
    const session = await t.run(async (ctx) =>
      ctx.db.get('sessions', s.sessionId),
    )
    expect(session?.cvKey).toBe(keyFor(s, 'cv.docx'))

    for (const mimeType of ['text/html', 'application/zip', '']) {
      await expect(
        t.mutation(internal.candidate.swapDocumentKey, {
          token: TOKEN,
          kind: 'cv',
          mimeType,
        }),
      ).rejects.toThrow('unsupported_document_type')
    }
  })
})

/**
 * h01. The slot came back with the object key, which embeds the organisation
 * and session ids a candidate has no use for — contradicting "never returned:
 * orgId" in lib/candidateView.ts. The key stays on the server now; attaching
 * derives it again from the kind and the type.
 */
describe('requesting a document slot', () => {
  beforeEach(() => {
    vi.stubEnv('OBJECT_STORE_ENDPOINT', 'https://s3.example.test')
    vi.stubEnv('OBJECT_STORE_REGION', 'fr-par')
    vi.stubEnv('OBJECT_STORE_BUCKET', 'media')
    vi.stubEnv('OBJECT_STORE_ACCESS_KEY_ID', 'test-access-key')
    vi.stubEnv('OBJECT_STORE_SECRET_ACCESS_KEY', 'test-secret-key')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns an upload URL and a type, never the object key', async () => {
    const t = newTest()
    await seed(t)
    const slot = await t.action(api.candidate.requestDocumentUpload, {
      token: TOKEN,
      kind: 'cv',
      mimeType: 'application/pdf',
      contentLength: 1_000,
    })
    expect(Object.keys(slot).sort()).toEqual(['contentType', 'uploadUrl'])
    expect(slot.contentType).toBe('application/pdf')
  })
})

// Fingerprint: convex/candidate.ts:requestDocumentUpload:signed-before-named
// A slot signed a PUT before any row named its key. A CV uploaded and never
// attached — a closed tab, a dropped connection — or attached under another
// type was named nowhere, so erasure could not find it and the candidate was
// told everything was deleted.
describe('a document slot is named before the upload', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed
  let deleted: Array<string>

  beforeEach(async () => {
    vi.stubEnv('OBJECT_STORE_ENDPOINT', 'https://s3.example.test')
    vi.stubEnv('OBJECT_STORE_REGION', 'fr-par')
    vi.stubEnv('OBJECT_STORE_BUCKET', 'media')
    vi.stubEnv('OBJECT_STORE_ACCESS_KEY_ID', 'test-access-key')
    vi.stubEnv('OBJECT_STORE_SECRET_ACCESS_KEY', 'test-secret-key')
    vi.stubEnv('PURGE_HASH_SALT', 'test-salt')
    deleted = []
    vi.spyOn(await import('./lib/objectStore'), 'deleteObjects').mockImplementation(
      (keys: Array<string>) => {
        deleted.push(...keys)
        return Promise.resolve()
      },
    )
    t = newTest()
    s = await seed(t)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  const requestSlot = (mimeType: string) =>
    t.action(api.candidate.requestDocumentUpload, {
      token: TOKEN,
      kind: 'cv',
      mimeType,
      contentLength: 1_000,
    })
  const named = async () =>
    (await t.query(internal.purge.collectSessionObjects, {
      sessionId: s.sessionId,
    }))!.keys.sort()

  it('is erased even if it is never attached', async () => {
    await requestSlot(DOCX)
    await t.action(api.candidate.deleteMyData, { token: TOKEN })
    expect(deleted).toContain(keyFor(s, 'cv.docx'))
  })

  it('stays named when attached under another type', async () => {
    await requestSlot('application/msword')
    await t.action(api.candidate.attachDocument, {
      token: TOKEN,
      kind: 'cv',
      mimeType: DOCX,
    })
    expect(await named()).toEqual(
      [keyFor(s, 'cv.doc'), keyFor(s, 'cv.docx')].sort(),
    )
    await t.action(api.candidate.deleteMyData, { token: TOKEN })
    expect(deleted).toContain(keyFor(s, 'cv.doc'))
  })

  it('is named once, by the row, once attached', async () => {
    await requestSlot(DOCX)
    await t.action(api.candidate.attachDocument, {
      token: TOKEN,
      kind: 'cv',
      mimeType: DOCX,
    })
    // The replaced CV was deleted by the attach; the new one is `cvKey`.
    expect(deleted).toEqual([keyFor(s, 'cv.pdf')])
    expect(await named()).toEqual([keyFor(s, 'cv.docx')])
  })
})
