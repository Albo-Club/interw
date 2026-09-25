import { describe, expect, it } from 'vitest'

import { invitationTokenOf } from './safe-redirect'

// Audit T12 (h06): `/register` and `/login` lock the address field to the
// invitation's when the return URL is an accept link.
describe('invitationTokenOf', () => {
  it('reads the token of an accept link', () => {
    expect(invitationTokenOf('/accept-invite/abc123')).toBe('abc123')
    expect(invitationTokenOf('/accept-invite/abc123?x=1#y')).toBe('abc123')
  })

  it('ignores every other return URL', () => {
    expect(invitationTokenOf(undefined)).toBeUndefined()
    expect(invitationTokenOf('/app')).toBeUndefined()
    expect(invitationTokenOf('/accept-invite/')).toBeUndefined()
    expect(invitationTokenOf('/accept-invite/a/b')).toBeUndefined()
  })
})
