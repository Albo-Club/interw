import { ConvexError } from 'convex/values'
import { HOUR, MINUTE, RateLimiter } from '@convex-dev/rate-limiter'

import { components } from './_generated/api'

export const rateLimiter = new RateLimiter(components.rateLimiter, {
  // Invitations: per inviter (~admin), prevents accidental spam.
  invitationCreate: {
    kind: 'token bucket',
    rate: 20,
    period: HOUR,
    capacity: 5,
  },
  // Sign-in code emails: per recipient email, charged by `perEmailQuota` in
  // convex/auth.ts. Room for a code, a resend and a retyped address; after
  // that, one every ten minutes.
  emailCodeSend: { kind: 'token bucket', rate: 6, period: HOUR, capacity: 3 },
  // Email-verification resends: per recipient email. Separate bucket so a
  // user re-asking for a verification link doesn't eat into sign-in codes.
  verificationSend: {
    kind: 'token bucket',
    rate: 5,
    period: HOUR,
    capacity: 3,
  },
  // Password-reset emails: per recipient email.
  passwordResetSend: {
    kind: 'token bucket',
    rate: 3,
    period: HOUR,
    capacity: 2,
  },
  // Password sign-in attempts: per email, charged by `perEmailQuota` in
  // convex/auth.ts, whether or not the account exists.
  signInAttempt: { kind: 'token bucket', rate: 10, period: HOUR, capacity: 10 },
  // "Your password was changed" notices: per user. Only a real change sends
  // one (server-side hooks), but a burst of changes should not become a burst
  // of emails.
  passwordChangedNotify: {
    kind: 'token bucket',
    rate: 3,
    period: HOUR,
    capacity: 2,
  },
  // Chat messages: per user. AI calls are expensive.
  chatSend: { kind: 'token bucket', rate: 30, period: MINUTE, capacity: 10 },
  // Job-ad import: per user. Each call is an outbound fetch plus a model
  // call, so it is both costly and an SSRF-adjacent surface.
  jobImport: { kind: 'token bucket', rate: 20, period: HOUR, capacity: 5 },
  // Candidate invitations: per recruiter. A bulk paste is one call, so this
  // caps campaigns rather than individual addresses.
  candidateInvite: {
    kind: 'token bucket',
    rate: 40,
    period: HOUR,
    capacity: 10,
  },
  // Candidate writes, keyed by token: consent, profile, segment bookkeeping.
  candidateWrite: { kind: 'token bucket', rate: 120, period: MINUTE, capacity: 30 },
  // Report share views, keyed by the resolved share, never the raw token.
  shareView: { kind: 'token bucket', rate: 120, period: MINUTE, capacity: 30 },
  // Playback URLs for a shared report, keyed by the resolved share. Asked for
  // once per page load and again when a URL lapses mid-playback; each call
  // signs one URL per answer.
  shareMedia: { kind: 'token bucket', rate: 30, period: MINUTE, capacity: 10 },
  // Convex storage upload URLs (avatar, logo, persona), per user. Nothing is
  // validated until the blob is attached, so an unmetered slot is free
  // storage for anyone with an account.
  storageUpload: { kind: 'token bucket', rate: 30, period: HOUR, capacity: 10 },
  // Report relaunches, per recruiter. Each one can re-bill transcriptions and
  // a deep-model completion; a stuck report needs one click, not a hundred.
  reportRelaunch: { kind: 'token bucket', rate: 10, period: HOUR, capacity: 3 },
})

type LimitName =
  | 'invitationCreate'
  | 'passwordChangedNotify'
  | 'chatSend'
  | 'jobImport'
  | 'candidateInvite'
  | 'candidateWrite'
  | 'shareView'
  | 'shareMedia'
  | 'storageUpload'
  | 'reportRelaunch'

/**
 * Throws a friendly ConvexError when a limit is hit. The data payload includes
 * the limit name so the UI can show contextual messages.
 */
export async function consumeLimit(
  ctx: Parameters<typeof rateLimiter.limit>[0],
  name: LimitName,
  key: string,
): Promise<void> {
  const result = await rateLimiter.limit(ctx, name, { key })
  if (!result.ok) {
    throw new ConvexError({
      code: 'rate_limited',
      limit: name,
      retryAfterMs: result.retryAfter,
    })
  }
}
