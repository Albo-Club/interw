/**
 * Whether a candidate holding a valid link may actually proceed, and why not.
 *
 * Pure and exhaustive on purpose: every candidate-facing function funnels
 * through it, so "can this person record right now?" has exactly one answer
 * in the codebase rather than one per handler.
 *
 * Note on what this does NOT decide: whether the token exists. An unknown
 * token is rejected before we get here, with an error that cannot be told
 * apart from any other unknown token. Once a token HAS resolved, the holder
 * has proved they were sent the link, and telling them plainly that it
 * expired is better than a dead end — it costs nothing against an attacker
 * who cannot guess 32 bytes in the first place.
 */

import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc } from '../_generated/dataModel'

export type SessionGateState =
  | 'ready'
  | 'resumable'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'closed'

export type SessionLike = {
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
  consentAcceptedAt?: number
}

export type ProjectLike = {
  status: 'draft' | 'active' | 'archived'
  expiresAt?: number
}

export type OrgLike = {
  deletingAt?: number
}

export type SessionGate = {
  state: SessionGateState
  /** True only when the candidate may record right now. */
  canRecord: boolean
  /** True when consent still has to be collected before recording. */
  needsConsent: boolean
}

export function evaluateSessionGate({
  session,
  project,
  org,
  now,
}: {
  session: SessionLike
  project: ProjectLike
  org: OrgLike
  now: number
}): SessionGate {
  const needsConsent = session.consentAcceptedAt === undefined

  const blocked = (state: SessionGateState): SessionGate => ({
    state,
    canRecord: false,
    needsConsent,
  })

  // Terminal session states win over everything: a completed interview stays
  // completed even if the role is later archived, and the candidate should be
  // told that rather than that the role is gone.
  if (session.status === 'completed') return blocked('completed')
  if (session.status === 'cancelled') return blocked('cancelled')
  if (session.status === 'expired') return blocked('expired')

  // An organisation being deleted closes every link at once, and must: its
  // erasure collects the keys to delete from the rows, so an upload reserved
  // after that point would land in the bucket with nothing left to name it.
  if (org.deletingAt !== undefined) return blocked('closed')

  // The role's own expiry closes every link at once — the usual reason is
  // "we have finished hiring", so it reads as expired, not as an error.
  if (project.expiresAt !== undefined && now > project.expiresAt) {
    return blocked('expired')
  }
  // Draft or archived: nobody should be able to sit an interview that is not
  // live, including through a link that was sent while it was.
  if (project.status !== 'active') return blocked('closed')

  return {
    state: session.status === 'in_progress' ? 'resumable' : 'ready',
    canRecord: !needsConsent,
    needsConsent,
  }
}

/** By id, never by index: `orderIndex` is a display order, the id is the question. */
export function answeredQuestionIds(
  segments: ReadonlyArray<{ questionId: string; uploadState: string }>,
): Set<string> {
  return new Set(
    segments
      .filter((segment) => segment.uploadState === 'uploaded')
      .map((segment) => segment.questionId),
  )
}

/**
 * Where the interview picks up: the first question, in order, that has no
 * answer on the server. The only resume cursor there is.
 *
 * There used to be two — `lastQuestionIndex`, advanced monotonically on each
 * upload, and the client's own first-unanswered scan — and a skipped question
 * made them disagree: the welcome screen announced question 4, the interview
 * resumed at 1, then walked into question 2 and re-recorded it over the saved
 * answer. Derived from the segments rather than stored, it cannot drift.
 */
export function nextQuestionIndex(
  questionIds: ReadonlyArray<string>,
  answered: ReadonlySet<string>,
): number {
  const index = questionIds.findIndex((id) => !answered.has(id))
  return index === -1 ? questionIds.length : index
}

/**
 * A session's position in its role: the questions in order, which ones the
 * server holds an answer for, and where to pick up. The welcome screen and the
 * runner both read it from here — the one read in this module, kept beside the
 * rule it feeds so the two screens cannot compute it differently.
 */
export async function loadProgress(
  ctx: GenericQueryCtx<DataModel>,
  session: Doc<'sessions'>,
) {
  const questions = await ctx.db
    .query('questions')
    .withIndex('by_project', (q) => q.eq('projectId', session.projectId))
    .collect()
  const segments = await ctx.db
    .query('segments')
    .withIndex('by_session', (q) => q.eq('sessionId', session._id))
    .collect()
  const answered = answeredQuestionIds(segments)
  return {
    questions,
    answered,
    nextQuestionIndex: nextQuestionIndex(
      questions.map((question) => question._id),
      answered,
    ),
  }
}
