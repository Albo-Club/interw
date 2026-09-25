/**
 * Signed URLs for project media (the recruiter's intro and question
 * recordings).
 *
 * Every function here mints a URL only after the caller's access has been
 * checked, and every key is derived server-side from the row it belongs to —
 * a caller never names the object it wants to write. Candidate media has its
 * own module (convex/interview.ts) with its own, token-based, check.
 */

import { ConvexError, v } from 'convex/values'

import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  deleteObjects,
  extensionForMimeType,
  presignGet,
  presignPut,
  projectMediaKey,
} from './lib/objectStore'
import { requireProjectAccess, requireProjectEditable } from './lib/projectAccess'
import type { Doc, Id } from './_generated/dataModel'

type MediaKind = NonNullable<Doc<'questions'>['mediaKind']>

/** A recruiter recording a question or an intro, in the browser. */
const ALLOWED_RECORDING_TYPES = [
  'video/webm',
  'video/mp4',
  'audio/webm',
  'audio/mp4',
]

/** The intro is filmed: a role opens on the recruiter's face or on nothing. */
const INTRO_RECORDING_TYPES = ['video/webm', 'video/mp4']

/** ~2 minutes of 720p WebM leaves plenty of headroom. */
const MAX_PROJECT_MEDIA_BYTES = 100 * 1024 * 1024

function normalizeMimeType(
  mimeType: string,
  allowed: ReadonlyArray<string> = ALLOWED_RECORDING_TYPES,
): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  if (!allowed.includes(base)) {
    throw new ConvexError('unsupported_media_type')
  }
  return base
}

function validateSize(contentLength: number): number {
  if (
    !Number.isInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_PROJECT_MEDIA_BYTES
  ) {
    throw new ConvexError('media_too_large')
  }
  return contentLength
}

/* ───────────────────────────── Upload ──────────────────────────────────── */

export const resolveIntroUpload = internalQuery({
  args: {
    projectId: v.id('projects'),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (ctx, { projectId, mimeType, contentLength }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    const contentType = normalizeMimeType(mimeType, INTRO_RECORDING_TYPES)
    validateSize(contentLength)
    return {
      key: projectMediaKey(
        project.orgId,
        project._id,
        'intro',
        extensionForMimeType(contentType),
      ),
      contentType,
    }
  },
})

export const resolveQuestionUpload = internalQuery({
  args: {
    questionId: v.id('questions'),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (ctx, { questionId, mimeType, contentLength }) => {
    const question = await ctx.db.get('questions', questionId)
    if (!question) throw new ConvexError('not_found')
    await requireProjectEditable(ctx, question.projectId)
    const contentType = normalizeMimeType(mimeType)
    validateSize(contentLength)
    return {
      key: projectMediaKey(
        question.orgId,
        question.projectId,
        `q-${question._id}`,
        extensionForMimeType(contentType),
      ),
      contentType,
    }
  },
})

/**
 * A one-shot upload slot.
 *
 * Three things are signed and therefore not negotiable by the client: the
 * key, the content type, and the exact byte length. The first stops a caller
 * writing over someone else's object, the second stops the slot being used to
 * park HTML on the bucket origin, the third stops a 40 GB upload from a
 * 4 MB promise.
 */
export const requestIntroUpload = action({
  args: {
    projectId: v.id('projects'),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; key: string; contentType: string }> => {
    const target = await ctx.runQuery(internal.media.resolveIntroUpload, args)
    return {
      uploadUrl: await presignPut(
        target.key,
        target.contentType,
        undefined,
        args.contentLength,
      ),
      key: target.key,
      contentType: target.contentType,
    }
  },
})

export const requestQuestionUpload = action({
  args: {
    questionId: v.id('questions'),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; key: string; contentType: string }> => {
    const target = await ctx.runQuery(internal.media.resolveQuestionUpload, args)
    return {
      uploadUrl: await presignPut(
        target.key,
        target.contentType,
        undefined,
        args.contentLength,
      ),
      key: target.key,
      contentType: target.contentType,
    }
  },
})

/* ───────────────────────────── Attach ──────────────────────────────────── */

/**
 * The content type `key` was issued for in this slot, or null when it is not
 * a key this slot can be issued at all.
 *
 * Re-derive rather than trust: the client is telling us which object it just
 * wrote, and the only acceptable answers are the keys an upload slot could
 * have named. A prefix match accepted `intro.zzz`, and the object it replaced
 * was deleted.
 */
function issuedType(
  key: string,
  slotKey: (extension: string) => string,
  types: ReadonlyArray<string>,
): string | null {
  return (
    types.find((type) => slotKey(extensionForMimeType(type)) === key) ?? null
  )
}

export const swapIntroKey = internalMutation({
  args: { projectId: v.id('projects'), key: v.string() },
  handler: async (ctx, { projectId, key }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    const slotKey = (extension: string) =>
      projectMediaKey(project.orgId, projectId, 'intro', extension)
    if (!issuedType(key, slotKey, INTRO_RECORDING_TYPES)) {
      throw new ConvexError('key_mismatch')
    }
    const previous = project.introMediaKey
    await ctx.db.patch('projects', projectId, { introMediaKey: key })
    return { previous: previous && previous !== key ? previous : null }
  },
})

export const swapQuestionKey = internalMutation({
  args: { questionId: v.id('questions'), key: v.string() },
  handler: async (ctx, { questionId, key }) => {
    const question = await ctx.db.get('questions', questionId)
    if (!question) throw new ConvexError('not_found')
    await requireProjectEditable(ctx, question.projectId)
    const slotKey = (extension: string) =>
      projectMediaKey(
        question.orgId,
        question.projectId,
        `q-${questionId}`,
        extension,
      )
    const type = issuedType(key, slotKey, ALLOWED_RECORDING_TYPES)
    if (!type) throw new ConvexError('key_mismatch')
    // Read off the key, like the key itself: it decides whether the prompt is
    // played in <audio> or <video>, and the client's word is not needed.
    const mediaKind = type.startsWith('video/') ? 'video' : 'audio'
    const previous = question.mediaKey
    await ctx.db.patch('questions', questionId, { mediaKey: key, mediaKind })
    return { previous: previous && previous !== key ? previous : null }
  },
})

/**
 * Point the row at the newly uploaded object, then delete whatever it pointed
 * at before. Re-recording a question in a different container changes the
 * extension, so without this the bucket accumulates every take.
 */
export const attachIntroMedia = action({
  args: { projectId: v.id('projects'), key: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { previous } = await ctx.runMutation(internal.media.swapIntroKey, args)
    if (previous) await deleteObjects([previous])
    return null
  },
})

export const attachQuestionMedia = action({
  args: { questionId: v.id('questions'), key: v.string() },
  handler: async (ctx, args): Promise<null> => {
    const { previous } = await ctx.runMutation(
      internal.media.swapQuestionKey,
      args,
    )
    if (previous) await deleteObjects([previous])
    return null
  },
})

export const clearIntroMedia = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    if (!project.introMediaKey) return null
    await ctx.db.patch('projects', projectId, { introMediaKey: undefined })
    await ctx.scheduler.runAfter(0, internal.media.deleteKeys, {
      keys: [project.introMediaKey],
    })
    return null
  },
})

export const clearQuestionMedia = mutation({
  args: { questionId: v.id('questions') },
  handler: async (ctx, { questionId }) => {
    const question = await ctx.db.get('questions', questionId)
    if (!question) throw new ConvexError('not_found')
    await requireProjectEditable(ctx, question.projectId)
    if (!question.mediaKey) return null
    await ctx.db.patch('questions', questionId, {
      mediaKey: undefined,
      mediaKind: undefined,
    })
    await ctx.scheduler.runAfter(0, internal.media.deleteKeys, {
      keys: [question.mediaKey],
    })
    return null
  },
})

/**
 * Bucket cleanup, scheduled from mutations, which cannot call out themselves.
 * Internal: nothing outside this deployment may name an object to delete.
 */
export const deleteKeys = internalAction({
  args: { keys: v.array(v.string()) },
  handler: async (_ctx, { keys }) => {
    await deleteObjects(keys)
    return null
  },
})

/* ───────────────────────────── Playback ────────────────────────────────── */

export const resolvePlayback = internalQuery({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectAccess(ctx, projectId)
    const questions = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    return {
      introKey: project.introMediaKey ?? null,
      questionKeys: questions.flatMap((q) =>
        q.mediaKey
          ? [{ questionId: q._id, key: q.mediaKey, kind: q.mediaKind ?? 'video' }]
          : [],
      ),
    }
  },
})

/**
 * Signed playback URLs for everything a project holds, in one call.
 *
 * One round trip rather than one per question: a wizard with eight recorded
 * questions should not make eight action calls to render.
 */
export const playbackUrls = action({
  args: { projectId: v.id('projects') },
  handler: async (
    ctx,
    { projectId },
  ): Promise<{
    intro: string | null
    questions: Array<{
      questionId: Id<'questions'>
      url: string
      kind: MediaKind
    }>
  }> => {
    const target = await ctx.runQuery(internal.media.resolvePlayback, {
      projectId,
    })
    return {
      intro: target.introKey ? await presignGet(target.introKey) : null,
      questions: await Promise.all(
        target.questionKeys.map(async (q) => ({
          questionId: q.questionId,
          url: await presignGet(q.key),
          kind: q.kind,
        })),
      ),
    }
  },
})

/* ───────────────────────────── Migration ───────────────────────────────── */

/**
 * One-off: move roles still on a retired intro mode (`text`, `audio`) to
 * `none`. They already read as `none` everywhere (`effectiveIntroMode`), so
 * this changes nothing a user sees; it exists so the schema can drop the two
 * literals. An audio intro's object goes with it — it is not a video, so it
 * can never become the intro. The text stays in `introText`, read by nothing.
 *
 * Not run by any deploy: `npx convex run media:migrateLegacyIntroModes` once
 * per deployment. It pages through the table by rescheduling itself.
 */
export const migrateLegacyIntroModes = internalMutation({
  args: { cursor: v.optional(v.union(v.string(), v.null())) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query('projects')
      .paginate({ cursor: cursor ?? null, numItems: 100 })
    const keys: Array<string> = []
    let migrated = 0
    for (const project of page.page) {
      if (project.introMode === 'none' || project.introMode === 'video') continue
      const audioKey =
        project.introMode === 'audio' ? project.introMediaKey : undefined
      if (audioKey) keys.push(audioKey)
      await ctx.db.patch('projects', project._id, {
        introMode: 'none',
        ...(audioKey ? { introMediaKey: undefined } : {}),
      })
      migrated++
    }
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, internal.media.deleteKeys, { keys })
    }
    if (!page.isDone) {
      await ctx.scheduler.runAfter(0, internal.media.migrateLegacyIntroModes, {
        cursor: page.continueCursor,
      })
    }
    return { migrated, done: page.isDone }
  },
})
