/**
 * Everything a candidate can reach. No account, ever — only a token.
 *
 * The rules this module exists to enforce, without exception:
 *
 *  1. Every function takes `token` and resolves it through `by_token` as its
 *     first act. An unknown token is `not_found`, indistinguishable from any
 *     other unknown token.
 *  2. Nothing returns a recruiter's note, a decision, a report, an object key
 *     or an organisation id. Responses are built by the explicit projectors in
 *     lib/candidateView.ts, never by returning a row.
 *  3. Writes are narrow: `acceptConsent`, `updateProfile`, `attachDocument`.
 *     There is no generic "patch these fields" mutation anywhere here, because
 *     a caller who can name fields can eventually name the wrong one.
 *  4. Every write is rate-limited on the session its token resolves to, never
 *     on the raw token: a token that resolves to nothing writes nothing, not
 *     even a limiter row.
 *
 * On the reads: `landing` is a reactive query and is deliberately not rate
 * limited. Convex caches queries, the payload is small, and a token cannot be
 * guessed — whereas throttling a page a nervous candidate is reloading would
 * lock them out of their own interview. The cost is on the write and signing
 * paths, and those are limited.
 */

import { ConvexError, v } from 'convex/values'

import {
  action,
  internalMutation,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import { appendSessionEvent } from './interview'
import {
  toCandidateProjectView,
  toCandidateSessionView,
} from './lib/candidateView'
import {
  candidatePrivacyReturns,
  candidateProjectReturns,
  candidateSessionReturns,
  sessionGateReturns,
} from './lib/candidateReturns'
import { effectiveNow } from './lib/clock'
import { evaluateSessionGate, loadProgress } from './lib/sessionState'
import { looksLikeToken } from './lib/tokens'
import {
  candidateDocumentKey,
  deleteObjects,
  presignPut,
  withPendingKey,
} from './lib/objectStore'
import { eraseSession } from './purge'
import { consumeLimit } from './rateLimiters'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc } from './_generated/dataModel'

const PHONE_MAX = 40
const LINKEDIN_MAX = 200
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024

/** Extension per accepted document type. A CV is a document, not a web page. */
const DOCUMENT_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
}

/**
 * Resolve a token to its session, or fail the same way for every token that
 * does not resolve. This is the only door into this module.
 */
async function requireSession(
  ctx: GenericQueryCtx<DataModel>,
  token: string,
): Promise<{
  session: Doc<'sessions'>
  project: Doc<'projects'>
  org: Doc<'organizations'>
}> {
  if (!looksLikeToken(token)) throw new ConvexError('not_found')
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('accessToken', token))
    .unique()
  if (!session) throw new ConvexError('not_found')
  const project = await ctx.db.get('projects', session.projectId)
  if (!project) throw new ConvexError('not_found')
  const org = await ctx.db.get('organizations', session.orgId)
  if (!org) throw new ConvexError('not_found')
  return { session, project, org }
}

/**
 * The candidate's own page: who is asking, what the role is, how long it
 * takes, and whether they can proceed.
 *
 * `now` comes from the caller rather than the clock, because a query that
 * reads the wall clock is not re-run as time passes and would cache a stale
 * "still open" past the role's expiry. It keeps the page reactive and does not
 * decide the gate: see convex/lib/clock.ts.
 */
export const landing = query({
  args: { token: v.string(), now: v.number() },
  // The projectors decide what a candidate sees; this makes Convex enforce it
  // at the boundary. See convex/lib/candidateReturns.ts.
  returns: v.object({
    organisationName: v.string(),
    session: candidateSessionReturns,
    project: candidateProjectReturns,
    gate: sessionGateReturns,
  }),
  handler: async (ctx, { token, now }) => {
    const { session, project, org } = await requireSession(ctx, token)
    const progress = await loadProgress(ctx, session)

    return {
      organisationName: org.name,
      session: toCandidateSessionView(session),
      project: toCandidateProjectView(project, progress.questions.length),
      gate: {
        ...evaluateSessionGate({
          session,
          project,
          org,
          now: effectiveNow(now),
        }),
        // The value `interview.questions` resumes at, from the same loader,
        // so the welcome screen cannot announce one question and the
        // interview open another.
        resumeAtIndex: progress.nextQuestionIndex,
      },
    }
  },
})

export const acceptConsent = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { session, project, org } = await requireSession(ctx, token)
    await consumeLimit(ctx, 'candidateWrite', session._id)

    const gate = evaluateSessionGate({
      session,
      project,
      org,
      now: Date.now(),
    })
    if (gate.state !== 'ready' && gate.state !== 'resumable') {
      throw new ConvexError(gate.state)
    }
    if (session.consentAcceptedAt !== undefined) return null

    const now = Date.now()
    await ctx.db.patch('sessions', session._id, {
      consentAcceptedAt: now,
      lastActivityAt: now,
    })
    await appendSessionEvent(ctx, session, {
      kind: 'consent_accepted',
      at: now,
    })
    return null
  },
})

/**
 * The optional details the role asks for. Narrow by design: name and email
 * came from the invitation and are not editable here, because changing them
 * would silently re-point an interview at a different person.
 */
export const updateProfile = mutation({
  args: {
    token: v.string(),
    phone: v.optional(v.string()),
    linkedin: v.optional(v.string()),
  },
  handler: async (ctx, { token, phone, linkedin }) => {
    const { session, project, org } = await requireSession(ctx, token)
    await consumeLimit(ctx, 'candidateWrite', session._id)

    const gate = evaluateSessionGate({
      session,
      project,
      org,
      now: Date.now(),
    })
    if (gate.state !== 'ready' && gate.state !== 'resumable') {
      throw new ConvexError(gate.state)
    }

    const patch: Partial<Doc<'sessions'>> = { lastActivityAt: Date.now() }
    if (phone !== undefined) {
      const trimmed = phone.trim()
      if (trimmed.length > PHONE_MAX) throw new ConvexError('invalid_phone')
      patch.candidatePhone = trimmed || undefined
    }
    if (linkedin !== undefined) {
      const trimmed = linkedin.trim()
      if (trimmed.length > LINKEDIN_MAX) {
        throw new ConvexError('invalid_linkedin')
      }
      if (trimmed && !/^https?:\/\//i.test(trimmed)) {
        throw new ConvexError('invalid_linkedin')
      }
      patch.candidateLinkedin = trimmed || undefined
    }
    await ctx.db.patch('sessions', session._id, patch)
    return null
  },
})

/* ─────────────────────── CV and cover letter upload ─────────────────────── */

/** The accepted document type a browser MIME type names, or a refusal. */
function documentType(mimeType: string): {
  contentType: string
  extension: string
} {
  const contentType = mimeType.split(';')[0].trim().toLowerCase()
  const extension = DOCUMENT_TYPES[contentType]
  if (!extension) throw new ConvexError('unsupported_document_type')
  return { contentType, extension }
}

/**
 * The gate and the field check shared by issuing a slot and attaching what
 * was written to it. `swapDocumentKey`'s caller then DELETES the object it
 * replaced, so without them anyone still holding the link — the candidate, or
 * whoever the invitation was forwarded to — could re-point `cvKey` and destroy
 * the CV the recruiter had already read, days after the interview closed.
 */
async function requireDocumentSlot(
  ctx: GenericQueryCtx<DataModel>,
  token: string,
  kind: 'cv' | 'cover',
): Promise<Doc<'sessions'>> {
  const { session, project, org } = await requireSession(ctx, token)
  const gate = evaluateSessionGate({ session, project, org, now: Date.now() })
  if (gate.state !== 'ready' && gate.state !== 'resumable') {
    throw new ConvexError(gate.state)
  }
  const field = kind === 'cv' ? 'cv' : 'coverLetter'
  if (!project.candidateFields[field].enabled) {
    throw new ConvexError('not_requested')
  }
  return session
}

/**
 * The key an upload slot writes to, named on the session BEFORE the PUT is
 * signed — the rule segments follow. Until `attachDocument` claims it, the
 * key waits in `pendingDocumentKeys`, so an upload whose attach never came,
 * or was attached under another type, is still an object erasure can name.
 */
export const reserveDocumentUpload = internalMutation({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (ctx, { token, kind, mimeType, contentLength }) => {
    const session = await requireDocumentSlot(ctx, token, kind)
    const { contentType, extension } = documentType(mimeType)
    if (
      !Number.isInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength > MAX_DOCUMENT_BYTES
    ) {
      throw new ConvexError('document_too_large')
    }
    await consumeLimit(ctx, 'candidateWrite', session._id)

    const key = candidateDocumentKey(session.orgId, session._id, kind, extension)
    await ctx.db.patch('sessions', session._id, {
      pendingDocumentKeys: withPendingKey(session.pendingDocumentKeys, key),
    })
    return { key, contentType }
  },
})

/**
 * An upload slot for a CV or a cover letter. The object key stays on the
 * server: it embeds the organisation and session ids, which a candidate has
 * no use for. `attachDocument` derives it again from the kind and the type.
 */
export const requestDocumentUpload = action({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ uploadUrl: string; contentType: string }> => {
    const target = await ctx.runMutation(
      internal.candidate.reserveDocumentUpload,
      args,
    )
    return {
      uploadUrl: await presignPut(
        target.key,
        target.contentType,
        undefined,
        args.contentLength,
      ),
      contentType: target.contentType,
    }
  },
})

/**
 * Rate limiting needs a mutation; actions borrow it through here. The token
 * is resolved first and the bucket is its session's, so a token that resolves
 * to nothing fails like every other one and leaves no limiter row behind.
 */
export const consumeWriteLimit = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { session } = await requireSession(ctx, token)
    await consumeLimit(ctx, 'candidateWrite', session._id)
    return session._id
  },
})

export const swapDocumentKey = internalMutation({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    mimeType: v.string(),
  },
  handler: async (ctx, { token, kind, mimeType }) => {
    const session = await requireDocumentSlot(ctx, token, kind)
    // Derived, never received: the only keys this row can point at are the
    // ones `reserveDocumentUpload` could have issued for this session.
    const key = candidateDocumentKey(
      session.orgId,
      session._id,
      kind,
      documentType(mimeType).extension,
    )

    const previous = kind === 'cv' ? session.cvKey : session.coverLetterKey
    await ctx.db.patch('sessions', session._id, {
      ...(kind === 'cv' ? { cvKey: key } : { coverLetterKey: key }),
      // Named by the field above from now on. Any other pending key stays
      // pending: its object may have landed, and erasure still has to find it.
      pendingDocumentKeys: session.pendingDocumentKeys?.filter(
        (pending) => pending !== key,
      ),
      lastActivityAt: Date.now(),
    })
    return { previous: previous && previous !== key ? previous : null }
  },
})

export const attachDocument = action({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    /** The type the slot was issued for, which names the key it wrote. */
    mimeType: v.string(),
  },
  handler: async (ctx, args): Promise<null> => {
    const { previous } = await ctx.runMutation(
      internal.candidate.swapDocumentKey,
      args,
    )
    if (previous) await deleteObjects([previous])
    return null
  },
})

/* ────────────────────────── Data, and erasing it ───────────────────────── */

/**
 * What is held about this candidate. Counts and booleans only — the page
 * exists to tell someone what exists about them and let them remove it, not
 * to replay their own interview back at them.
 */
export const privacySummary = query({
  args: { token: v.string() },
  returns: candidatePrivacyReturns,
  handler: async (ctx, { token }) => {
    const { session, project, org } = await requireSession(ctx, token)
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    const transcripts = await ctx.db
      .query('transcripts')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .unique()

    return {
      organisationName: org.name,
      language: project.language,
      candidateName: session.candidateName,
      candidateEmail: session.candidateEmail,
      answerCount: segments.filter((s) => s.uploadState === 'uploaded').length,
      hasTranscript: transcripts.length > 0,
      hasAnalysis: report !== null,
      hasDocuments:
        session.cvKey !== undefined || session.coverLetterKey !== undefined,
      completedAt: session.completedAt ?? null,
    }
  },
})

/**
 * Erase everything, on the candidate's word alone.
 *
 * No confirmation step server-side and no grace period: the right to erasure
 * is not conditional on the recruiter's convenience. The UI warns clearly that
 * it is irreversible and that it ends the application, which is the honest
 * trade — and then it does exactly what it says.
 */
export const deleteMyData = action({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<{ deleted: true }> => {
    const sessionId = await ctx.runMutation(
      internal.candidate.consumeWriteLimit,
      { token },
    )
    await eraseSession(ctx, sessionId, 'candidate_request')
    return { deleted: true }
  },
})
