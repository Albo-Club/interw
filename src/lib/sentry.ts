import * as Sentry from '@sentry/react'

let initialized = false

/**
 * A candidate's link, `/s/<token>`, a report share link, `/r/<token>`, and a
 * role's public link, `/apply/<token>`: each token opens what it names to
 * whoever holds it.
 */
const TOKEN_PATH = /\/(s|r|apply)\/[A-Za-z0-9_-]+/g

/** The sign-in code in a `/login/code#…&code=` link: it opens the account. */
const SIGN_IN_CODE = /([#&]code=)\d+/g

/**
 * Mask every candidate and share token in an event before it leaves the
 * browser.
 *
 * The tokens are path segments, not query parameters, so no default scrubbing
 * touches them. A candidate token grants read AND write on the candidate's
 * session, `deleteMyData` included; a share token opens a report and signs
 * URLs on the candidate's video. They sat in `request.url`, in navigation and
 * fetch breadcrumbs, and in transaction names. Rewriting the serialised event
 * catches all of them, including fields added by a future integration.
 */
export function scrubAccessTokens<T>(event: T): T {
  return JSON.parse(
    JSON.stringify(event)
      .replace(TOKEN_PATH, '/$1/[token]')
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
    beforeSend: scrubAccessTokens,
    // Inert while tracing is off, kept on purpose: turning tracing on later
    // must not be the change that ships tokens in transaction names.
    beforeSendTransaction: scrubAccessTokens,
    // Errors only: no tracing, no replay, no source maps — see KNOWN_ISSUES.md
    // § "Sentry collects errors only". Recording the DOM of an interview
    // screen would ship it to a third party, so adding `replayIntegration()`
    // is a GDPR decision, not a config tweak.
  })
  initialized = true
}

export { Sentry }
