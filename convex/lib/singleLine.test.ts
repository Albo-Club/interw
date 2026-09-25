import { describe, expect, it } from 'vitest'

import { singleLine } from './singleLine'

describe('singleLine', () => {
  it('turns line breaks and control characters into a single space', () => {
    expect(singleLine('Acme\r\nBcc: x@evil.test')).toBe('Acme Bcc: x@evil.test')
    expect(singleLine('a\u2028b\u0000c\td')).toBe('a b c d')
  })

  it('trims, and leaves ordinary text alone', () => {
    expect(singleLine('  Élodie Dupont-Martin  ')).toBe('Élodie Dupont-Martin')
  })
})
