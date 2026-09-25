// What this browser remembers about signing in, in localStorage. Hints only —
// a "Last used" badge, whether a lost session is worth a notice, where a code
// link should land — so every access tolerates storage being unavailable
// (private mode, blocked site data) and falls back to remembering nothing.

export type SignInMethod = 'google' | 'email' | 'password'

const METHOD_KEY = 'interw.auth.lastMethod'
// Set while this browser holds a session it did not sign out of: a signed-out
// visit to /app then means the session expired or was revoked elsewhere.
const ACTIVE_KEY = 'interw.auth.active'
const PENDING_KEY = 'interw.auth.pendingCode'
// A code lives ten minutes; a pending return URL a little longer.
const PENDING_TTL_MS = 15 * 60 * 1000

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // Storage unavailable: the hint is lost, nothing else depends on it.
  }
}

export function lastSignInMethod(): SignInMethod | null {
  const value = read(METHOD_KEY)
  return value === 'google' || value === 'email' || value === 'password'
    ? value
    : null
}

export function rememberSignInMethod(method: SignInMethod): void {
  write(METHOD_KEY, method)
}

/** The app is open on a session: mark it, however it was opened. */
export function rememberSessionActive(): void {
  if (read(ACTIVE_KEY) !== '1') write(ACTIVE_KEY, '1')
}

export function rememberSignOut(): void {
  write(ACTIVE_KEY, null)
}

/** True once if this browser lost a session it never signed out of. */
export function takeLostSession(): boolean {
  const lost = read(ACTIVE_KEY) === '1'
  write(ACTIVE_KEY, null)
  return lost
}

/**
 * Where to land after confirming the code from the email link, when that link
 * is opened in the browser that asked for it. Another device has no record
 * and lands on the default page.
 */
export function rememberPendingCode(email: string, redirect: string | undefined) {
  write(PENDING_KEY, JSON.stringify({ email, redirect, at: Date.now() }))
}

export function pendingCodeRedirect(email: string): string | undefined {
  try {
    const pending = JSON.parse(read(PENDING_KEY) ?? 'null') as {
      email?: unknown
      redirect?: unknown
      at?: unknown
    } | null
    if (
      pending?.email === email &&
      typeof pending.redirect === 'string' &&
      typeof pending.at === 'number' &&
      Date.now() - pending.at < PENDING_TTL_MS
    )
      return pending.redirect
  } catch {
    // Malformed entry: no redirect.
  }
  return undefined
}
