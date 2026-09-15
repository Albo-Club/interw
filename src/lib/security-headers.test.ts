import { describe, expect, it } from 'vitest'

import { securityHeaders } from './security-headers'

/**
 * Audit 2026-09-15, B1 and B2: the template's headers were never revisited
 * when the product gained a camera. `camera=()` is an EMPTY allowlist — it
 * denies the document itself — so `getUserMedia` threw `NotAllowedError` on
 * Chrome, and a CSP with no `media-src` fell back to `default-src 'self'`,
 * which blocks every `<video>` served from the object-store bucket.
 *
 * Neither failure is visible from a unit test of the app: they are two
 * strings. So they are asserted as strings.
 */

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(';').map((part) => {
      const [name, ...values] = part.trim().split(/\s+/)
      return [name, values.join(' ')]
    }),
  )
}

describe('securityHeaders', () => {
  it('grants camera and microphone to the document itself (B1)', () => {
    const policy = securityHeaders()['Permissions-Policy']
    expect(policy).toContain('camera=(self)')
    expect(policy).toContain('microphone=(self)')
  })

  it('grants camera and microphone to nobody else (B1)', () => {
    const policy = securityHeaders()['Permissions-Policy']
    expect(policy).not.toContain('camera=*')
    expect(policy).not.toContain('microphone=*')
    expect(policy).toContain('geolocation=()')
  })

  it('lets the media host and blob: URLs play (B2)', () => {
    const csp = directives(
      securityHeaders('https://interw-media.s3.fr-par.scw.cloud')[
        'Content-Security-Policy'
      ],
    )
    expect(csp.get('media-src')).toBe(
      "'self' https://interw-media.s3.fr-par.scw.cloud blob:",
    )
  })

  it('falls back to https: when no media origin is configured (B2)', () => {
    const csp = directives(securityHeaders()['Content-Security-Policy'])
    expect(csp.get('media-src')).toBe("'self' https: blob:")
  })

  it('keeps the rest of the policy closed', () => {
    const headers = securityHeaders()
    const csp = directives(headers['Content-Security-Policy'])
    expect(csp.get('default-src')).toBe("'self'")
    expect(csp.get('frame-ancestors')).toBe("'none'")
    expect(headers['X-Frame-Options']).toBe('DENY')
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
  })
})
