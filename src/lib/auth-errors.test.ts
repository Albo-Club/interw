import { describe, expect, it } from 'vitest'
import { classifyAuthError } from './auth-errors'

// Shapes as the Better Auth client receives them (status + body `code`).
describe('classifyAuthError', () => {
  it('reads the per-address email quota as rate limiting, not as "sent"', () => {
    expect(classifyAuthError({ status: 429, code: 'RATE_LIMITED' })).toBe('RATE_LIMITED')
    expect(classifyAuthError({ status: 429 })).toBe('RATE_LIMITED')
  })

  it('tells the sign-in code failures apart', () => {
    expect(classifyAuthError({ status: 400, code: 'INVALID_OTP' })).toBe('CODE_INVALID')
    expect(classifyAuthError({ status: 400, code: 'OTP_EXPIRED' })).toBe('CODE_EXPIRED')
    // A 403, but not an unverified email.
    expect(classifyAuthError({ status: 403, code: 'TOO_MANY_ATTEMPTS' })).toBe('CODE_ATTEMPTS')
  })

  it('keeps an unexplained server error unknown', () => {
    expect(classifyAuthError({ status: 500, statusText: 'Internal Server Error' })).toBe('UNKNOWN')
  })
})
