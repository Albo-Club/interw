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
import {
  introModeValidator,
  languageValidator,
  sessionEventKindValidator,
  sessionStatusValidator,
} from './schema'
import { candidateQuestionReturns } from './lib/candidateReturns'
import { toCandidateQuestionView } from './lib/candidateView'
import { effectiveNow } from './lib/clock'
import { evaluateSessionGate, loadProgress } from './lib/sessionState'
import { generateToken, looksLikeToken } from './lib/tokens'
import {
  extensionForMimeType,
  presignGet,
  presignPut,
  segmentKey,
} from './lib/objectStore'
import { consumeLimit } from './rateLimiters'
import { RESEND_FROM, resend } from './email'
import { candidateCompletedEmail } from './emailTemplates'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

const MAX_SEGMENT_BYTES = 300 * 1024 * 1024
/** Newest events kept per session. See `appendSessionEvent`. */
const MAX_SESSION_EVENTS = 200
/** Slack over a question's time limit for the recorder's own stop latency. */
const DURATION_MARGIN_SECONDS = 5
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
  const org = await ctx.db.get('organizations', session.orgId)
  if (!org) throw new ConvexError('not_found')

  const gate = evaluateSessionGate({ session, project, org, now })
  if (gate.state !== 'ready' && gate.state !== 'resumable') {
    throw new ConvexError(gate.state)
  }
  if (gate.needsConsent) throw new ConvexError('consent_required')
  return { session, project }
}

/**
 * The one way a `sessionEvents` row is written. The cap lives here, at the
 * insertion point, and not in one handler: every writer of this table is a
 * public token-gated mutation, and the rate limiter still admits 120 writes a
 * minute — so without it, the size of this table for one session is chosen by
 * whoever holds the link. It is a support trail, not an audit log: the most
 * recent events are the ones that explain what just went wrong.
 */
export async function appendSessionEvent(
  ctx: GenericMutationCtx<DataModel>,
  session: Doc<'sessions'>,
  event: { kind: Doc<'sessionEvents'>['kind']; detail?: string; at: number },
): Promise<void> {
  const oldest = await ctx.db
    .query('sessionEvents')
    .withIndex('by_session', (q) => q.eq('sessionId', session._id))
    .take(MAX_SESSION_EVENTS)
  // Room for the row about to be written, so the count never exceeds the cap.
  const excess = Math.max(0, oldest.length - MAX_SESSION_EVENTS + 1)
  for (const stale of oldest.slice(0, excess)) {
    await ctx.db.delete('sessionEvents', stale._id)
  }
  await ctx.db.insert('sessionEvents', {
    orgId: session.orgId,
    sessionId: session._id,
    kind: event.kind,
    detail: event.detail?.slice(0, 500),
    at: event.at,
  })
}

/** The questions, in order, as the candidate may see them. */
export const questions = query({
  args: { token: v.string(), now: v.number() },
  // Enforced at the boundary rather than trusted to the projector. See
  // convex/lib/candidateReturns.ts.
  returns: v.object({
    questions: v.array(
      v.object({
        ...candidateQuestionReturns.fields,
        answered: v.boolean(),
      }),
    ),
    /** Where the interview picks up. The client computes no resume point of
     *  its own; see `nextQuestionIndex` in convex/lib/sessionState.ts. */
    nextQuestionIndex: v.number(),
    /** The role's language, which the whole candidate surface speaks. */
    language: languageValidator,
    introMode: introModeValidator,
    introText: v.union(v.string(), v.null()),
    hasIntroMedia: v.boolean(),
  }),
  handler: async (ctx, { token, now }) => {
    // The candidate's clock keeps the gate reactive; it does not decide it.
    // See convex/lib/clock.ts.
    const { session, project } = await requireOpenSession(
      ctx,
      token,
      effectiveNow(now),
    )
    const progress = await loadProgress(ctx, session)

    return {
      questions: progress.questions.map((question) => ({
        ...toCandidateQuestionView(question),
        answered: progress.answered.has(question._id),
      })),
      nextQuestionIndex: progress.nextQuestionIndex,
      language: project.language,
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
      await appendSessionEvent(ctx, session, {
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
 * what makes a retry after a dropped connection safe — unless the answer is
 * already saved. A candidate gets one attempt: an answer the server holds is
 * never reserved again, so it cannot be recorded over. That is an outcome,
 * not an error — typically an earlier attempt landed and only its response
 * was lost — so it comes back as `answered`, like `finish`'s
 * `alreadyCompleted`.
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
    if (existing?.uploadState === 'uploaded') return { status: 'answered' as const }

    const fields = {
      audioKey,
      videoKey,
      uploadState: 'pending' as const,
      recordedAt: now,
    }
    let segmentId: Id<'segments'>
    if (existing) {
      segmentId = existing._id
      // A different container, or no video this time, changes the keys. The
      // earlier PUT may already have landed, so the keys this slot leaves
      // behind stay named on the row until erasure has deleted them.
      const current = [audioKey, videoKey]
      const supersededKeys = [
        ...new Set([
          ...(existing.supersededKeys ?? []),
          existing.audioKey,
          existing.videoKey,
        ]),
      ].filter(
        (key): key is string => key !== undefined && !current.includes(key),
      )
      await ctx.db.patch('segments', existing._id, {
        ...fields,
        supersededKeys,
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
      status: 'reserved' as const,
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
  ): Promise<
    | { status: 'answered' }
    | {
        status: 'reserved'
        segmentId: Id<'segments'>
        audio: { uploadUrl: string; contentType: string }
        video: { uploadUrl: string; contentType: string } | null
      }
  > => {
    const slot = await ctx.runMutation(internal.interview.reserveSegment, args)
    if (slot.status === 'answered') return slot
    return {
      status: 'reserved',
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
 * The answer is in the bucket. `lastQuestionIndex` is kept for the recruiter's
 * progress display; it is not where the candidate resumes — that is derived
 * from the segments, see `nextQuestionIndex`.
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

    // The client's number is a hint for display, never the measurement the
    // report is computed from (see `saveTranscript`) — and even as a hint it
    // stays within what the recorder could have produced.
    if (!Number.isFinite(durationSeconds)) {
      throw new ConvexError('invalid_duration')
    }
    const question = await ctx.db.get('questions', segment.questionId)
    const ceiling =
      (question?.maxResponseSeconds ?? 120) + DURATION_MARGIN_SECONDS
    await ctx.db.patch('segments', segmentId, {
      uploadState: 'uploaded',
      durationSeconds: Math.min(
        ceiling,
        Math.max(0, Math.round(durationSeconds)),
      ),
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
    await appendSessionEvent(ctx, session, {
      kind: 'upload_failed',
      detail,
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
    await appendSessionEvent(ctx, session, { kind, detail, at: Date.now() })
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
    const session = await resolveSessionByToken(ctx, token)
    if (session.status === 'completed') return { alreadyCompleted: true }

    const project = await ctx.db.get('projects', session.projectId)
    if (!project) throw new ConvexError('not_found')
    const org = await ctx.db.get('organizations', session.orgId)
    if (!org) throw new ConvexError('not_found')

    // Not `requireOpenSession`, for one reason only: a candidate who has just
    // recorded their answers must be able to finish even if the role's own
    // deadline passed a minute ago. Refusing that would strand a sat
    // interview in `in_progress` with nothing to trigger the pipeline. Every
    // other blocker stays terminal here as it is everywhere else — a cancelled
    // link, a session that is itself expired, a role that is not live — or
    // finishing would undo the recruiter's decision and start the pipeline.
    const gate = evaluateSessionGate({ session, project, org, now })
    const roleDeadlinePassed =
      gate.state === 'expired' &&
      session.status !== 'expired' &&
      project.status === 'active'
    if (
      gate.state !== 'ready' &&
      gate.state !== 'resumable' &&
      !roleDeadlinePassed
    ) {
      throw new ConvexError(gate.state)
    }
    // Nothing to finish if nothing was started.
    if (session.status !== 'in_progress' || gate.needsConsent) {
      throw new ConvexError('not_started')
    }
    await consumeLimit(ctx, 'candidateWrite', token)

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
    await ctx.scheduler.runAfter(0, internal.interview.sendCompletionEmail, {
      sessionId: session._id,
    })
    return { alreadyCompleted: false }
  },
})

const COMPLETED_TEMPLATE = 'candidate-completed'

/**
 * Tell the candidate their interview arrived, and give them the one link that
 * lets them erase it later — the data page, which until now they could only
 * reach from the screen they had just closed.
 *
 * Its own scheduled job rather than part of `finish`, so nothing about the
 * email — a missing `SITE_URL`, a template that throws — can fail the
 * transaction that completes the interview. `finish` schedules it once, and a
 * scheduled mutation runs exactly once.
 */
export const sendCompletionEmail = internalMutation({
  args: { sessionId: v.id('sessions') },
  handler: async (ctx, { sessionId }) => {
    // Erased between `finish` and this job: there is nobody left to write to.
    const session = await ctx.db.get('sessions', sessionId)
    if (!session) return null

    const project = await ctx.db.get('projects', session.projectId)
    if (!project) return null
    const org = await ctx.db.get('organizations', session.orgId)
    const siteUrl = process.env.SITE_URL
    if (!siteUrl) throw new ConvexError('site_url_not_configured')

    const { subject, html, text } = candidateCompletedEmail({
      locale: project.language,
      candidateName: session.candidateName,
      jobTitle: project.jobTitle ?? project.title,
      orgName: org?.name ?? '',
      privacyUrl: `${siteUrl.replace(/\/+$/, '')}/s/${session.accessToken}/privacy`,
    })
    const providerId = await resend.sendEmail(ctx, {
      from: RESEND_FROM,
      to: session.candidateEmail,
      subject,
      html,
      text,
    })
    await ctx.db.insert('emailLog', {
      orgId: session.orgId,
      template: COMPLETED_TEMPLATE,
      recipient: session.candidateEmail,
      status: 'sent',
      providerId,
      sessionId,
      createdAt: Date.now(),
    })
    return null
  },
})

/** 12 months after completion, media is purged. See convex/retention.ts. */
export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000

/* ── Browser test fixtures (e2e/interview.spec.ts) ─────────────────────────
 * Internal, so only a deploy key reaches them, through `npx convex run`. The
 * org has no member who can sign in, and the candidate's address is Resend's
 * delivery sink: the completion email really goes out.
 * ------------------------------------------------------------------------ */
const E2E_ORG_SLUG = 'e2e-interview'
const E2E_EMAIL = 'delivered@resend.dev'
/** A run that dies before its own cleanup leaves no media behind for long. */
const E2E_PURGE_AFTER_MS = 24 * 60 * 60 * 1000

/** A fresh two-question session; the org and role are created once. */
export const seedE2eSession = internalMutation({
  args: {},
  returns: v.object({ token: v.string() }),
  handler: async (ctx) => {
    const now = Date.now()
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', E2E_ORG_SLUG))
      .unique()
    let project =
      org &&
      (await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', org._id))
        .first())
    if (!org) {
      const userId = await ctx.db.insert('users', {
        betterAuthId: `seed:${E2E_ORG_SLUG}`,
        email: E2E_EMAIL,
        superAdmin: false,
        createdAt: now,
      })
      const orgId = await ctx.db.insert('organizations', {
        slug: E2E_ORG_SLUG,
        name: 'E2E',
        createdBy: userId,
        createdAt: now,
      })
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role: 'owner',
        joinedAt: now,
      })
      const projectId = await ctx.db.insert('projects', {
        orgId,
        slug: 'interview',
        title: 'E2E interview',
        status: 'active',
        language: 'en',
        introMode: 'none',
        maxDurationMinutes: 5,
        candidateFields: {
          phone: { enabled: false, required: false },
          linkedin: { enabled: false, required: false },
          cv: { enabled: false, required: false },
          coverLetter: { enabled: false, required: false },
        },
        createdBy: userId,
        createdAt: now,
        restricted: false,
        sessionCount: 0,
        completedSessionCount: 0,
      })
      for (const [orderIndex, content] of [
        'Introduce yourself in one sentence.',
        'Name one thing you are proud of.',
      ].entries()) {
        await ctx.db.insert('questions', {
          orgId,
          projectId,
          orderIndex,
          content,
          maxResponseSeconds: 60,
        })
      }
      project = await ctx.db.get('projects', projectId)
    }
    if (!project) throw new ConvexError('not_found')

    const token = generateToken()
    await ctx.db.insert('sessions', {
      orgId: project.orgId,
      projectId: project._id,
      accessToken: token,
      candidateName: 'E2E Candidate',
      candidateEmail: E2E_EMAIL,
      status: 'pending',
      lastQuestionIndex: 0,
      invitedBy: project.createdBy,
      invitedAt: now,
      purgeAfter: now + E2E_PURGE_AFTER_MS,
    })
    await ctx.db.patch('projects', project._id, {
      sessionCount: project.sessionCount + 1,
    })
    return { token }
  },
})

/** What the browser test checks in the database once the candidate is done. */
export const e2eSessionState = internalQuery({
  args: { token: v.string() },
  returns: v.object({
    status: sessionStatusValidator,
    uploadedSegments: v.number(),
  }),
  handler: async (ctx, { token }) => {
    const session = await resolveSessionByToken(ctx, token)
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    return {
      status: session.status,
      uploadedSegments: segments.filter((s) => s.uploadState === 'uploaded')
        .length,
    }
  },
})
