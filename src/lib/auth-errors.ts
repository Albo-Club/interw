/**
 * Classify Better Auth client errors into a small, stable, UI-facing set.
 *
 * Why bother: BA returns granular codes (USER_NOT_FOUND vs
 * INVALID_EMAIL_OR_PASSWORD vs INVALID_PASSWORD …). Surfacing those
 * verbatim leaks enumeration (an attacker learns *which* field is wrong).
 * We collapse them, then format user-facing copy per context.
 *
 * Source codes: node_modules/@better-auth/core/dist/error/codes.mjs
 */

export type AuthErrorCode =
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'EMAIL_ALREADY_REGISTERED'
  | 'EMAIL_INVALID'
  | 'PASSWORD_TOO_SHORT'
  | 'PASSWORD_TOO_LONG'
  | 'TOKEN_INVALID'
  | 'TOKEN_EXPIRED'
  | 'SESSION_EXPIRED'
  | 'CODE_INVALID'
  | 'CODE_EXPIRED'
  | 'CODE_ATTEMPTS'
  | 'RATE_LIMITED'
  | 'NETWORK'
  | 'UNKNOWN'

export interface AuthErrorLike {
  code?: string | null
  status?: number | null
  statusText?: string | null
  message?: string | null
}

const CODE_MAP: Partial<Record<string, AuthErrorCode>> = {
  INVALID_EMAIL_OR_PASSWORD: 'INVALID_CREDENTIALS',
  INVALID_PASSWORD: 'INVALID_CREDENTIALS',
  INVALID_USER: 'INVALID_CREDENTIALS',
  // Collapsed on purpose — distinguishing "user not found" from "wrong
  // password" is exactly the enumeration leak we want to block.
  USER_NOT_FOUND: 'INVALID_CREDENTIALS',
  USER_EMAIL_NOT_FOUND: 'INVALID_CREDENTIALS',
  CREDENTIAL_ACCOUNT_NOT_FOUND: 'INVALID_CREDENTIALS',
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  USER_ALREADY_EXISTS: 'EMAIL_ALREADY_REGISTERED',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: 'EMAIL_ALREADY_REGISTERED',
  INVALID_EMAIL: 'EMAIL_INVALID',
  PASSWORD_TOO_SHORT: 'PASSWORD_TOO_SHORT',
  PASSWORD_TOO_LONG: 'PASSWORD_TOO_LONG',
  INVALID_TOKEN: 'TOKEN_INVALID',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  SESSION_NOT_FRESH: 'SESSION_EXPIRED',
  // Email sign-in code (email-otp plugin). A wrong code and a code for
  // another address are the same INVALID_OTP, so nothing leaks here.
  INVALID_OTP: 'CODE_INVALID',
  OTP_EXPIRED: 'CODE_EXPIRED',
  TOO_MANY_ATTEMPTS: 'CODE_ATTEMPTS',
  // Per-address email quota (`perEmailQuota` in convex/auth.ts), sent as a 429.
  RATE_LIMITED: 'RATE_LIMITED',
}

export function classifyAuthError(
  err: AuthErrorLike | null | undefined,
): AuthErrorCode {
  if (!err) return 'UNKNOWN'
  if (err.status === 429) return 'RATE_LIMITED'
  if (err.code) {
    const mapped = CODE_MAP[err.code]
    if (mapped) return mapped
  }
  if (err.status === 403) return 'EMAIL_NOT_VERIFIED'
  if (err.status === 401) return 'INVALID_CREDENTIALS'
  if (err.status == null && err.code == null) return 'NETWORK'
  return 'UNKNOWN'
}

// `send`: a request that emails someone (code, reset link, verification link).
export type AuthErrorContext = 'signin' | 'reset' | 'change' | 'send'

type Translate = (key: string) => string

/**
 * Format a classified error into user-facing copy via the `errors` i18n
 * namespace. Pass a `t` bound to that namespace (e.g.
 * `useTranslation('errors')`). Some codes render differently depending on the
 * surrounding flow.
 */
export function formatAuthError(
  code: AuthErrorCode,
  ctx: AuthErrorContext,
  t: Translate,
): string {
  // The per-address email quota refills in minutes, not "a moment".
  if (code === 'RATE_LIMITED' && ctx === 'send') {
    return t('auth.RATE_LIMITED_send')
  }
  return t(`auth.${code}`)
}
