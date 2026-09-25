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
  // Password sign-ins: per account (keyed on a hash of the address), charged
  // by `perEmailQuota` on every attempt. Better Auth's per-IP rule trusts a
  // header the client can set; this one does not. Room for a few fumbles,
  // then one guess every six minutes — the email code stays available.
  passwordSignIn: { kind: 'token bucket', rate: 10, period: HOUR, capacity: 5 },
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
  // Candidate reads, keyed by token. Generous — a candidate reloading a page
  // mid-interview must never be locked out — but bounded, because these are
  // the only functions reachable without an account.
  candidateRead: { kind: 'token bucket', rate: 240, period: MINUTE, capacity: 60 },
  // Candidate writes, keyed by token: consent, profile, segment bookkeeping.
  candidateWrite: { kind: 'token bucket', rate: 120, period: MINUTE, capacity: 30 },
  // Report share views, keyed by the resolved share, never the raw token.
  shareView: { kind: 'token bucket', rate: 120, period: MINUTE, capacity: 30 },
})

type LimitName =
  | 'invitationCreate'
  | 'passwordChangedNotify'
  | 'chatSend'
  | 'jobImport'
  | 'candidateInvite'
  | 'candidateRead'
  | 'candidateWrite'
  | 'shareView'

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
