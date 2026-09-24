import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

import { linkStateFromError } from './errorState'

/** E5. `state.notFound` was dead copy: no path ever rendered it. */
describe('linkStateFromError', () => {
  it.each([
    ['not_found', 'notFound'],
    ['expired', 'expired'],
    ['closed', 'closed'],
    ['cancelled', 'cancelled'],
    ['completed', 'completed'],
  ])('reads %s as the %s state', (code, state) => {
    expect(linkStateFromError(new ConvexError(code))).toBe(state)
  })

  it('leaves real failures to the crash screen', () => {
    expect(linkStateFromError(new ConvexError('rate_limited'))).toBeNull()
    expect(linkStateFromError(new Error('boom'))).toBeNull()
  })
})
