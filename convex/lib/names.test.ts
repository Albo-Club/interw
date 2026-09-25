import { describe, expect, it } from 'vitest'

import { NAME_MAX, clampLine, singleLine } from './names'

/**
 * Audit T12 (h10): a display name or an organisation name travels into email
 * subjects and one-line UI, where a line break is an injection, not
 * formatting.
 */
describe('singleLine', () => {
  it('turns every line break and control character into one space', () => {
    expect(singleLine('Acme\r\nBcc: victim@example.test')).toBe(
      'Acme Bcc: victim@example.test',
    )
    expect(singleLine('a b c\u0085d\te\u0000f')).toBe('a b c d e f')
  })

  it('trims, and keeps ordinary text as it is', () => {
    expect(singleLine('  Élodie  Durand ')).toBe('Élodie  Durand')
  })
})

describe('clampLine', () => {
  it('caps the length without splitting a character', () => {
    expect(clampLine('x'.repeat(NAME_MAX + 20), NAME_MAX)).toHaveLength(
      NAME_MAX,
    )
    expect(clampLine('😀😀😀', 2)).toBe('😀😀')
  })

  it('is single-line first', () => {
    expect(clampLine('ab\r\ncd', 4)).toBe('ab c')
  })
})
