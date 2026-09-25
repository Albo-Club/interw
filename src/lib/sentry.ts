import * as Sentry from '@sentry/react'

let initialized = false

/** A candidate's link, `/s/<token>`: the token opens their interview. */
const CANDIDATE_PATH = /\/s\/[A-Za-z0-9_-]+/g

/** The sign-in code in a `/login/code#…&code=` link: it opens the account. */
const SIGN_IN_CODE = /([#&]code=)\d+/g

/**
 * Mask every candidate token in an event before it leaves the browser.
 *
 * The token is a path segment, not a query parameter, so no default scrubbing
 * touches it — and it grants read AND write on the candidate's session,
 * `deleteMyData` included. It sat in `request.url`, in navigation and fetch
 * breadcrumbs, and in transaction names. Rewriting the serialised event
 * catches all of them, including fields added by a future integration.
 */
export function scrubCandidateTokens<T>(event: T): T {
  return JSON.parse(
    JSON.stringify(event)
      .replace(CANDIDATE_PATH, '/s/[token]')
      // The page strips the fragment on load, but the navigation breadcrumb
      // recorded before that still carries it.
      .replace(SIGN_IN_CODE, '$1[code]'),
  ) as T
}

export function initSentry() {
  if (initialized) return
  const dsn = (import.meta as { env: Record<string, string | undefined> }).env
    .VITE_SENTRY_DSN
  if (!dsn) return
  Sentry.init({
    dsn,
    environment: (import.meta as { env: Record<string, string | undefined> })
      .env.MODE,
    tracesSampleRate: 0.1,
    beforeSend: scrubCandidateTokens,
    beforeSendTransaction: scrubCandidateTokens,
    replaysOnErrorSampleRate: 1.0,
    replaysSessionSampleRate: 0,
  })
  initialized = true
}

export { Sentry }
