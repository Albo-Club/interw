import { describe, expect, it } from 'vitest'

import { generateToken, looksLikeToken } from './tokens'

describe('generateToken', () => {
  it('is URL-safe and unpadded', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateToken()).toMatch(/^[A-Za-z0-9_-]+$/)
    }
  })

  it('carries 32 bytes of entropy by default', () => {
    // 32 bytes → ceil(32 * 4 / 3) = 43 base64 characters once padding is cut.
    expect(generateToken()).toHaveLength(43)
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 1000 }, () => generateToken()))
    expect(seen.size).toBe(1000)
  })
})

describe('looksLikeToken', () => {
  it('accepts what generateToken produces', () => {
    expect(looksLikeToken(generateToken())).toBe(true)
  })

  it('rejects the shapes an attacker would probe with', () => {
    for (const value of [
      '',
      'short',
      '../../etc/passwd',
      'a'.repeat(200),
      'has spaces',
      'semi;colon',
    ]) {
      expect(looksLikeToken(value)).toBe(false)
    }
  })
})
