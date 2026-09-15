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

export type SessionGateState =
  | 'ready'
  | 'resumable'
  | 'completed'
  | 'cancelled'
  | 'expired'
  | 'closed'

export type SessionLike = {
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
  lastQuestionIndex: number
  consentAcceptedAt?: number
}

export type ProjectLike = {
  status: 'draft' | 'active' | 'archived'
  expiresAt?: number
}

export type SessionGate = {
  state: SessionGateState
  /** True only when the candidate may record right now. */
  canRecord: boolean
  /** True when consent still has to be collected before recording. */
  needsConsent: boolean
  /** Where a resumed interview picks up. */
  resumeAtIndex: number
}

export function evaluateSessionGate({
  session,
  project,
  now,
}: {
  session: SessionLike
  project: ProjectLike
  now: number
}): SessionGate {
  const resumeAtIndex = Math.max(0, session.lastQuestionIndex)
  const needsConsent = session.consentAcceptedAt === undefined

  const blocked = (state: SessionGateState): SessionGate => ({
    state,
    canRecord: false,
    needsConsent,
    resumeAtIndex,
  })

  // Terminal session states win over everything: a completed interview stays
  // completed even if the role is later archived, and the candidate should be
  // told that rather than that the role is gone.
  if (session.status === 'completed') return blocked('completed')
  if (session.status === 'cancelled') return blocked('cancelled')
  if (session.status === 'expired') return blocked('expired')

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
    resumeAtIndex,
  }
}
