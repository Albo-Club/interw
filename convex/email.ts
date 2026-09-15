import { Resend } from '@convex-dev/resend'
import { components, internal } from './_generated/api'

export const RESEND_FROM = process.env.RESEND_FROM!

/**
 * The explicit `: Resend` annotation is load-bearing. `onEmailEvent` points at
 * `internal.emailEvents.record`, and `internal` is typed from every Convex
 * module including this one — so without the annotation TypeScript walks into
 * the cycle and infers `any` for `resend`, which then poisons inference across
 * the whole backend. Same family as the Better Auth trigger cycle documented
 * in CLAUDE.md.
 */
export const resend: Resend = new Resend(components.resend, {
  testMode: process.env.RESEND_TEST_MODE !== 'false',
  // Delivery outcomes come back through the webhook registered in
  // convex/http.ts and land on the matching `emailLog` row. An invitation
  // that bounced is not a candidate ignoring you, and the difference is the
  // recruiter's to act on.
  onEmailEvent: internal.emailEvents.record,
})
