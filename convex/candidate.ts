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
 *  4. Every write is rate-limited on the token.
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
  internalQuery,
  mutation,
  query,
} from './_generated/server'
import { internal } from './_generated/api'
import {
  toCandidateProjectView,
  toCandidateSessionView,
} from './lib/candidateView'
import {
  candidateProjectReturns,
  candidateSessionReturns,
  sessionGateReturns,
} from './lib/candidateReturns'
import { evaluateSessionGate, loadProgress } from './lib/sessionState'
import { looksLikeToken } from './lib/tokens'
import {
  candidateDocumentKey,
  deleteObjects,
  presignPut,
} from './lib/objectStore'
import { hashEmail } from './purge'
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
): Promise<{ session: Doc<'sessions'>; project: Doc<'projects'> }> {
  if (!looksLikeToken(token)) throw new ConvexError('not_found')
  const session = await ctx.db
    .query('sessions')
    .withIndex('by_token', (q) => q.eq('accessToken', token))
    .unique()
  if (!session) throw new ConvexError('not_found')
  const project = await ctx.db.get('projects', session.projectId)
  if (!project) throw new ConvexError('not_found')
  return { session, project }
}

/**
 * The candidate's own page: who is asking, what the role is, how long it
 * takes, and whether they can proceed.
 *
 * `now` comes from the caller rather than the clock, because a query that
 * reads the wall clock is not re-run as time passes and would cache a stale
 * "still open" past the role's expiry.
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
    const { session, project } = await requireSession(ctx, token)
    const org = await ctx.db.get('organizations', session.orgId)
    const progress = await loadProgress(ctx, session)

    return {
      organisationName: org?.name ?? '',
      session: toCandidateSessionView(session),
      project: toCandidateProjectView(project, progress.questions.length),
      gate: {
        ...evaluateSessionGate({ session, project, now }),
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
    const { session, project } = await requireSession(ctx, token)
    await consumeLimit(ctx, 'candidateWrite', token)

    const gate = evaluateSessionGate({ session, project, now: Date.now() })
    if (gate.state !== 'ready' && gate.state !== 'resumable') {
      throw new ConvexError(gate.state)
    }
    if (session.consentAcceptedAt !== undefined) return null

    const now = Date.now()
    await ctx.db.patch('sessions', session._id, {
      consentAcceptedAt: now,
      lastActivityAt: now,
    })
    await ctx.db.insert('sessionEvents', {
      orgId: session.orgId,
      sessionId: session._id,
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
    const { session, project } = await requireSession(ctx, token)
    await consumeLimit(ctx, 'candidateWrite', token)

    const gate = evaluateSessionGate({ session, project, now: Date.now() })
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

export const resolveDocumentUpload = internalQuery({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    mimeType: v.string(),
    contentLength: v.number(),
  },
  handler: async (ctx, { token, kind, mimeType, contentLength }) => {
    const { session, project } = await requireSession(ctx, token)
    const gate = evaluateSessionGate({ session, project, now: Date.now() })
    if (gate.state !== 'ready' && gate.state !== 'resumable') {
      throw new ConvexError(gate.state)
    }

    const field = kind === 'cv' ? 'cv' : 'coverLetter'
    if (!project.candidateFields[field].enabled) {
      throw new ConvexError('not_requested')
    }
    const base = mimeType.split(';')[0].trim().toLowerCase()
    const extension = DOCUMENT_TYPES[base]
    if (!extension) throw new ConvexError('unsupported_document_type')
    if (
      !Number.isInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength > MAX_DOCUMENT_BYTES
    ) {
      throw new ConvexError('document_too_large')
    }

    return {
      key: candidateDocumentKey(
        session.orgId,
        session._id,
        kind,
        extension,
      ),
      contentType: base,
    }
  },
})

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
  ): Promise<{ uploadUrl: string; key: string; contentType: string }> => {
    await ctx.runMutation(internal.candidate.consumeWriteLimit, {
      token: args.token,
    })
    const target = await ctx.runQuery(
      internal.candidate.resolveDocumentUpload,
      args,
    )
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

/** Rate limiting needs a mutation; actions borrow it through here. */
export const consumeWriteLimit = internalMutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    if (!looksLikeToken(token)) throw new ConvexError('not_found')
    await consumeLimit(ctx, 'candidateWrite', token)
    return null
  },
})

export const swapDocumentKey = internalMutation({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    key: v.string(),
  },
  handler: async (ctx, { token, kind, key }) => {
    const { session, project } = await requireSession(ctx, token)
    // The same two checks `resolveDocumentUpload` makes, replayed here. The
    // caller of this mutation then DELETES the object it replaced, so without
    // them anyone still holding the link — the candidate, or whoever the
    // invitation was forwarded to — could point `cvKey` at a name that does
    // not exist and destroy the CV the recruiter had already read, days after
    // the interview closed.
    const gate = evaluateSessionGate({ session, project, now: Date.now() })
    if (gate.state !== 'ready' && gate.state !== 'resumable') {
      throw new ConvexError(gate.state)
    }
    const field = kind === 'cv' ? 'cv' : 'coverLetter'
    if (!project.candidateFields[field].enabled) {
      throw new ConvexError('not_requested')
    }

    // Re-derive the acceptable prefix instead of trusting the key we are
    // handed: a candidate must not be able to point their row at an object
    // belonging to someone else's session.
    const expectedPrefix = candidateDocumentKey(
      session.orgId,
      session._id,
      kind,
      '',
    )
    if (!key.startsWith(expectedPrefix)) throw new ConvexError('key_mismatch')

    const previous = kind === 'cv' ? session.cvKey : session.coverLetterKey
    await ctx.db.patch('sessions', session._id, {
      ...(kind === 'cv' ? { cvKey: key } : { coverLetterKey: key }),
      lastActivityAt: Date.now(),
    })
    return { previous: previous && previous !== key ? previous : null }
  },
})

export const attachDocument = action({
  args: {
    token: v.string(),
    kind: v.union(v.literal('cv'), v.literal('cover')),
    key: v.string(),
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
  args: { token: v.string(), now: v.number() },
  handler: async (ctx, { token }) => {
    const { session, project } = await requireSession(ctx, token)
    const org = await ctx.db.get('organizations', session.orgId)
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
      organisationName: org?.name ?? '',
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
    await ctx.runMutation(internal.candidate.consumeWriteLimit, { token })
    const sessionId = await ctx.runQuery(internal.candidate.sessionIdForToken, {
      token,
    })
    const objects = await ctx.runQuery(internal.purge.collectSessionObjects, {
      sessionId,
    })
    if (!objects) return { deleted: true }

    // Objects first: a failure here is retried by the caller and finds the
    // rows still present. The reverse order would orphan video in the bucket.
    await deleteObjects(objects.keys)
    await ctx.runMutation(internal.purge.deleteSessionRecords, {
      sessionId,
      reason: 'candidate_request',
      candidateEmailHash: await hashEmail(objects.candidateEmail),
      objectsDeleted: objects.keys.length,
    })
    return { deleted: true }
  },
})

export const sessionIdForToken = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { session } = await requireSession(ctx, token)
    return session._id
  },
})
