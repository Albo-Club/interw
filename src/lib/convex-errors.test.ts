import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

import { convexErrorCode, errorMessageKey } from './convex-errors'

describe('convexErrorCode', () => {
  it('reads a plain string code', () => {
    expect(convexErrorCode(new ConvexError('project_archived'))).toBe(
      'project_archived',
    )
  })

  it('reads a code out of a structured payload', () => {
    expect(
      convexErrorCode(new ConvexError({ code: 'rate_limited', retryAfterMs: 5 })),
    ).toBe('rate_limited')
  })

  it('returns null for an ordinary error', () => {
    expect(convexErrorCode(new Error('boom'))).toBeNull()
    expect(convexErrorCode('boom')).toBeNull()
  })
})

describe('errorMessageKey', () => {
  it('scopes a known code to the domain namespace', () => {
    expect(errorMessageKey(new ConvexError('no_questions'), 'projects').key).toBe(
      'projects:errors.no_questions',
    )
  })

  // An unrecognised failure must not put an internal identifier on screen.
  it('falls back to the generic message for an unknown failure', () => {
    expect(errorMessageKey(new Error('kaboom'), 'projects').key).toBe(
      'common:errorBoundary.title',
    )
  })
})
