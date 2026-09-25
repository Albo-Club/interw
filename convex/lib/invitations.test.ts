import { describe, expect, it } from 'vitest'

import { emailsMatch, normalizeEmail } from './invitations'

/**
 * Audit T12 (h05/h06): `normalizeEmail` used `toLowerCase()`, which folds all
 * of Unicode. Two addresses that differ in their mailbox — the Kelvin sign
 * U+212A against the letter K, a dotted capital I against `i` — then compared
 * equal, and an invitation for one could be accepted by the other.
 */
describe('normalizeEmail', () => {
  it('folds ASCII case and trims', () => {
    expect(normalizeEmail('  Kate.Doe@Example.TEST ')).toBe(
      'kate.doe@example.test',
    )
  })

  it('leaves every non-ASCII letter as it is', () => {
    expect(normalizeEmail('Kate@example.test')).toBe(
      'Kate@example.test',
    )
    expect(normalizeEmail('İnes@example.test')).toBe(
      'İnes@example.test',
    )
    expect(normalizeEmail('ÉLODIE@example.test')).toBe('Élodie@example.test')
  })

  it('never makes two distinct addresses collide', () => {
    expect(emailsMatch('kate@example.test', 'Kate@example.test')).toBe(
      false,
    )
    expect(emailsMatch('ines@example.test', 'İnes@example.test')).toBe(
      false,
    )
    expect(emailsMatch('KATE@example.test', 'kate@EXAMPLE.test')).toBe(true)
  })
})
