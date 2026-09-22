import { Resend } from '@convex-dev/resend'
import { components, internal } from './_generated/api'
import { isPrivateHost } from './lib/safeUrl'

export const RESEND_FROM = process.env.RESEND_FROM!

const testMode = process.env.RESEND_TEST_MODE !== 'false'

/** The host this deployment answers on — '' when it has none, which `isPrivateHost` reads as private. */
const siteHost = (() => {
  try {
    return new URL(process.env.SITE_URL ?? '').hostname
  } catch {
    return ''
  }
})()

/**
 * Test mode silently loses the sign-up verification email — Better Auth sends
 * it as a background task, so the rejection never reaches the browser. Refuse
 * to load instead, the way the `SITE_URL` guard in convex/auth.ts does; see
 * KNOWN_ISSUES.md § "Resend test-mode trap".
 *
 * `SITE_URL` is the discriminator rather than `APP_ENV` because the deployment
 * that lost those emails ran with `APP_ENV=development` and a public address in
 * front of it.
 */
if (testMode && !isPrivateHost(siteHost)) {
  throw new Error(
    `[interw] RESEND_TEST_MODE is not "false" while SITE_URL is ` +
      `"${process.env.SITE_URL}". Every email would be rejected as a non-test ` +
      'recipient, and the sign-up one silently. Run: ' +
      'pnpm exec convex env set RESEND_TEST_MODE false',
  )
}

/**
 * The explicit `: Resend` annotation is load-bearing. `onEmailEvent` points at
 * `internal.emailEvents.record`, and `internal` is typed from every Convex
 * module including this one — so without the annotation TypeScript walks into
 * the cycle and infers `any` for `resend`, which then poisons inference across
 * the whole backend. Same family as the Better Auth trigger cycle documented
 * in CLAUDE.md.
 */
export const resend: Resend = new Resend(components.resend, {
  testMode,
  // Delivery outcomes come back through the webhook registered in
  // convex/http.ts and land on the matching `emailLog` row. An invitation
  // that bounced is not a candidate ignoring you, and the difference is the
  // recruiter's to act on.
  onEmailEvent: internal.emailEvents.record,
})
