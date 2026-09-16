/**
 * The interview engine, server side. Token-scoped like the rest of the
 * candidate surface; see convex/candidate.ts for the rules it follows.
 *
 * The shape of this module is set by one fact: **a candidate gets one
 * attempt**. So every answer is uploaded the moment it is finished rather
 * than at the end, every step is idempotent so a retry after a dropped
 * connection cannot corrupt what is already saved, and a failure is always a
 * state the client can see and act on — never a silent one.
 */

import { ConvexError, v } from 'convex/values'

import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { sessionEventKindValidator } from './schema'
import { toCandidateQuestionView } from './lib/candidateView'
import { effectiveNow } from './lib/clock'
import { evaluateSessionGate } from './lib/sessionState'
import { looksLikeToken } from './lib/tokens'
import {
  extensionForMimeType,
  presignGet,
  presignPut,
  segmentKey,
} from './lib/objectStore'
import { consumeLimit } from './rateLimiters'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

const MAX_SEGMENT_BYTES = 300 * 1024 * 1024
/** Newest events kept per session. See `logEvent`. */
const MAX_SESSION_EVENTS = 200
const ALLOWED_VIDEO_TYPES = ['video/webm', 'video/mp4']
const ALLOWED_AUDIO_TYPES = ['audio/webm', 'audio/mp4', 'audio/mpeg']

/**
 * Resolve a token to its session, or fail the same way every token that does
 * not resolve fails. This IS the access check for the candidate surface —
 * there is no account to check against.
 */
async function resolveSessionByToken(
  ctx: GenericQueryCtx<DataModel>,
  token: string,
): Promise<Doc<'sessions'>> {
  if (!looksLikeToken(token)) throw new ConvexError('not_found')
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('accessToken', token))
    .unique()
  if (!session) throw new ConvexError('not_found')
  return session
}

/** The same, plus "and this interview is actually open right now". */
async function requireOpenSession(
  ctx: GenericQueryCtx<DataModel>,
  token: string,
  now: number,
): Promise<{ session: Doc<'sessions'>; project: Doc<'projects'> }> {
  const session = await resolveSessionByToken(ctx, token)
  const project = await ctx.db.get('projects', session.projectId)
  if (!project) throw new ConvexError('not_found')

  const gate = evaluateSessionGate({ session, project, now })
  if (gate.state !== 'ready' && gate.state !== 'resumable') {
    throw new ConvexError(gate.state)
  }
  if (gate.needsConsent) throw new ConvexError('consent_required')
  return { session, project }
}

/** The questions, in order, as the candidate may see them. */
export const questions = query({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    // The candidate's clock keeps the gate reactive; it does not decide it.
    // See convex/lib/clock.ts.
    const { session, project } = await requireOpenSession(
      ctx,
      token,
      effectiveNow(now),
    )
    const rows = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    // By id, not by index: `orderIndex` is renumbered when the trame is
    // edited, `questionId` is not. See convex/pipeline.ts.
    const answered = new Set(
      segments
        .filter((segment) => segment.uploadState === 'uploaded')
        .map((segment) => segment.questionId),
    )

    return {
      questions: rows.map((question) => ({
        ...toCandidateQuestionView(question),
        answered: answered.has(question._id),
      })),
      resumeAtIndex: session.lastQuestionIndex,
      introMode: project.introMode,
      introText: project.introText ?? null,
      hasIntroMedia: project.introMediaKey !== undefined,
    }
  },
})

export const start = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const now = Date.now()
    const { session } = await requireOpenSession(ctx, token, now)
    await consumeLimit(ctx, 'candidateWrite', token)
    if (session.status === 'pending') {
      await ctx.db.patch('sessions', session._id, {
        status: 'in_progress',
        startedAt: now,
        lastActivityAt: now,
      })
    } else {
      await ctx.db.patch('sessions', session._id, { lastActivityAt: now })
      await ctx.db.insert('sessionEvents', {
        orgId: session.orgId,
        sessionId: session._id,
        kind: 'interview_resumed',
        at: now,
      })
    }
    return null
  },
})

/** Signed playback URLs for the intro and each recorded question prompt. */
export const resolvePromptMedia = internalQuery({
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token, now }) => {
    const { project } = await requireOpenSession(ctx, token, effectiveNow(now))
    const rows = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    return {
      introKey: project.introMediaKey ?? null,
      questionKeys: rows.flatMap((question) =>
        question.mediaKey
          ? [{ questionId: question._id, key: question.mediaKey }]
          : [],
      ),
    }
  },
})

/**
 * An action has the server's clock, so it uses it. `now` is still accepted,
 * and still ignored: an expired role must not be able to sign playback URLs
 * for whoever kept the link.
 */
export const promptMediaUrls = action({
  args: { token: v.string(), now: v.optional(v.number()) },
  handler: async (
    ctx,
    { token },
  ): Promise<{
    intro: string | null
    questions: Array<{ questionId: Id<'questions'>; url: string }>
  }> => {
    await ctx.runMutation(internal.candidate.consumeWriteLimit, { token })
    const target = await ctx.runQuery(internal.interview.resolvePromptMedia, {
      token,
      now: Date.now(),
    })
    return {
      intro: target.introKey ? await presignGet(target.introKey) : null,
      questions: await Promise.all(
        target.questionKeys.map(async (question) => ({
          questionId: question.questionId,
          url: await presignGet(question.key),
        })),
      ),
    }
  },
})

/* ─────────────────────────── Answer upload ─────────────────────────────── */

function validateMedia(
  mimeType: string,
  contentLength: number,
  allowed: Array<string>,
): { contentType: string; extension: string } {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  if (!allowed.includes(base)) throw new ConvexError('unsupported_media_type')
  if (
    !Number.isInteger(contentLength) ||
    contentLength <= 0 ||
    contentLength > MAX_SEGMENT_BYTES
  ) {
    throw new ConvexError('media_too_large')
  }
  return { contentType: base, extension: extensionForMimeType(base) }
}

/**
 * Reserve the slot for one answer.
 *
 * The `segments` row is written BEFORE the upload, carrying the keys. That
 * ordering is what makes purging exact: every object this candidate ever
 * created is named in the database, even the ones whose upload then failed,
 * so "delete everything about this person" never has to guess or scan.
 *
 * Re-requesting the same question replaces the reservation in place, which is
 * what makes a retry after a dropped connection safe.
 */
export const reserveSegment = internalMutation({
  args: {
    token: v.string(),
    questionIndex: v.number(),
    audio: v.object({ mimeType: v.string(), contentLength: v.number() }),
    video: v.optional(
      v.object({ mimeType: v.string(), contentLength: v.number() }),
    ),
  },
  handler: async (ctx, { token, questionIndex, audio, video }) => {
    const now = Date.now()
    const { session, project } = await requireOpenSession(ctx, token, now)
    await consumeLimit(ctx, 'candidateWrite', token)

    const question = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) =>
        q.eq('projectId', project._id).eq('orderIndex', questionIndex),
      )
      .unique()
    if (!question) throw new ConvexError('unknown_question')

    const audioMedia = validateMedia(
      audio.mimeType,
      audio.contentLength,
      ALLOWED_AUDIO_TYPES,
    )
    const videoMedia = video
      ? validateMedia(video.mimeType, video.contentLength, ALLOWED_VIDEO_TYPES)
      : null

    const audioKey = segmentKey(
      session.orgId,
      session._id,
      questionIndex,
      audioMedia.extension,
    )
    const videoSlot = videoMedia
      ? {
          key: segmentKey(
            session.orgId,
            session._id,
            questionIndex,
            videoMedia.extension,
          ),
          contentType: videoMedia.contentType,
        }
      : null
    const videoKey = videoSlot?.key

    const existing = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) =>
        q.eq('sessionId', session._id).eq('questionIndex', questionIndex),
      )
      .unique()

    const fields = {
      audioKey,
      videoKey,
      uploadState: 'pending' as const,
      recordedAt: now,
    }
    let segmentId: Id<'segments'>
    if (existing) {
      segmentId = existing._id
      await ctx.db.patch('segments', existing._id, {
        ...fields,
        uploadAttempts: existing.uploadAttempts + 1,
      })
    } else {
      segmentId = await ctx.db.insert('segments', {
        orgId: session.orgId,
        sessionId: session._id,
        questionId: question._id,
        questionIndex,
        ...fields,
        uploadAttempts: 1,
      })
    }

    await ctx.db.patch('sessions', session._id, { lastActivityAt: now })
    return {
      segmentId,
      audio: { key: audioKey, contentType: audioMedia.contentType },
      video: videoSlot,
    }
  },
})

export const requestSegmentUpload = action({
  args: {
    token: v.string(),
    questionIndex: v.number(),
    audio: v.object({ mimeType: v.string(), contentLength: v.number() }),
    video: v.optional(
      v.object({ mimeType: v.string(), contentLength: v.number() }),
    ),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{
    segmentId: Id<'segments'>
    audio: { uploadUrl: string; contentType: string }
    video: { uploadUrl: string; contentType: string } | null
  }> => {
    const slot = await ctx.runMutation(internal.interview.reserveSegment, args)
    return {
      segmentId: slot.segmentId,
      audio: {
        uploadUrl: await presignPut(
          slot.audio.key,
          slot.audio.contentType,
          undefined,
          args.audio.contentLength,
        ),
        contentType: slot.audio.contentType,
      },
      video:
        slot.video && args.video
          ? {
              uploadUrl: await presignPut(
                slot.video.key,
                slot.video.contentType,
                undefined,
                args.video.contentLength,
              ),
              contentType: slot.video.contentType,
            }
          : null,
    }
  },
})

/**
 * The answer is in the bucket. Advancing `lastQuestionIndex` here, and only
 * here, is what makes "resume where I left off" mean "resume after the last
 * answer that actually arrived".
 */
export const markSegmentUploaded = mutation({
  args: {
    token: v.string(),
    segmentId: v.id('segments'),
    durationSeconds: v.number(),
  },
  handler: async (ctx, { token, segmentId, durationSeconds }) => {
    const now = Date.now()
    const { session } = await requireOpenSession(ctx, token, now)
    await consumeLimit(ctx, 'candidateWrite', token)

    const segment = await ctx.db.get('segments', segmentId)
    // Scoping the segment to the resolved session is what stops a token from
    // marking another candidate's answer as uploaded.
    if (!segment || segment.sessionId !== session._id) {
      throw new ConvexError('not_found')
    }

    await ctx.db.patch('segments', segmentId, {
      uploadState: 'uploaded',
      durationSeconds: Math.max(0, Math.round(durationSeconds)),
    })
    await ctx.db.patch('sessions', session._id, {
      lastQuestionIndex: Math.max(
        session.lastQuestionIndex,
        segment.questionIndex + 1,
      ),
      lastActivityAt: now,
    })
    return null
  },
})

export const markSegmentFailed = mutation({
  args: { token: v.string(), segmentId: v.id('segments'), detail: v.string() },
  handler: async (ctx, { token, segmentId, detail }) => {
    const now = Date.now()
    const { session } = await requireOpenSession(ctx, token, now)
    await consumeLimit(ctx, 'candidateWrite', token)

    const segment = await ctx.db.get('segments', segmentId)
    if (!segment || segment.sessionId !== session._id) {
      throw new ConvexError('not_found')
    }
    await ctx.db.patch('segments', segmentId, { uploadState: 'failed' })
    await ctx.db.insert('sessionEvents', {
      orgId: session.orgId,
      sessionId: session._id,
      kind: 'upload_failed',
      detail: detail.slice(0, 500),
      at: now,
    })
    return null
  },
})

/** Candidate-side technical trail. Narrow, capped, and purged with the session. */
export const logEvent = mutation({
  args: {
    token: v.string(),
    kind: sessionEventKindValidator,
    detail: v.optional(v.string()),
  },
  handler: async (ctx, { token, kind, detail }) => {
    // Token resolution only, not the full gate: a diagnostic event must still
    // be recordable when something has gone wrong enough that the interview
    // is no longer "open" — that is exactly when the trail is worth having.
    const session = await resolveSessionByToken(ctx, token)
    await consumeLimit(ctx, 'candidateWrite', token)

    // Capped per session, oldest first. This endpoint is public, gated only by
    // the token, and the rate limiter still allows 120 writes a minute — so
    // the size of this table for one session was chosen by whoever held the
    // link. It is a support trail, not an audit log: the most recent two
    // hundred events are the ones that explain what just went wrong.
    const existing = await ctx.db
      .query('sessionEvents')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .take(MAX_SESSION_EVENTS + 1)
    for (const stale of existing.slice(0, existing.length - MAX_SESSION_EVENTS)) {
      await ctx.db.delete('sessionEvents', stale._id)
    }

    await ctx.db.insert('sessionEvents', {
      orgId: session.orgId,
      sessionId: session._id,
      kind,
      detail: detail?.slice(0, 500),
      at: Date.now(),
    })
    return null
  },
})

/**
 * The interview is over.
 *
 * Idempotent: a candidate who double-taps, or whose network retried the
 * request, must not start the analysis pipeline twice. The counter and the
 * retention clock are set in the same transaction as the status.
 */
export const finish = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const now = Date.now()
    // Deliberately `resolveSessionByToken` and not `requireOpenSession`: a
    // candidate who has just recorded their answers must be able to finish
    // even if the role expired a minute ago. Refusing here would strand a
    // completed interview in `in_progress` with nothing to trigger the
    // pipeline — punishing the candidate for our own deadline.
    const session = await resolveSessionByToken(ctx, token)
    if (session.status === 'completed') return { alreadyCompleted: true }
    await consumeLimit(ctx, 'candidateWrite', token)

    const project = await ctx.db.get('projects', session.projectId)
    if (!project) throw new ConvexError('not_found')

    await ctx.db.patch('sessions', session._id, {
      status: 'completed',
      completedAt: now,
      lastActivityAt: now,
      durationSeconds: session.startedAt
        ? Math.round((now - session.startedAt) / 1000)
        : undefined,
      purgeAfter: now + RETENTION_MS,
    })
    await ctx.db.patch('projects', project._id, {
      completedSessionCount: project.completedSessionCount + 1,
    })

    await ctx.scheduler.runAfter(0, internal.pipeline.onSessionCompleted, {
      sessionId: session._id,
    })
    return { alreadyCompleted: false }
  },
})

/** 12 months after completion, media is purged. See convex/retention.ts. */
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000
