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

const MEDIA = 'https://interw-media.s3.fr-par.scw.cloud'
const CONVEX = 'https://happy-otter-123.convex.cloud'

/**
 * Whether a CSP source list lets `url` load, for the source forms this policy
 * uses: keywords, schemes, exact origins and one leading-wildcard host. The
 * image assertions below go through it, so they state what each image needs
 * to load rather than repeat the string the code emits.
 */
function allows(sources: string, url: string): boolean {
  const target = new URL(url)
  return sources.split(' ').some((source) => {
    if (source === "'self'") return target.origin === 'https://app.example'
    if (source.endsWith(':') && !source.includes('/')) {
      return target.protocol === source
    }
    const wildcard = /^https:\/\/\*\.(.+)$/.exec(source)
    if (wildcard) {
      return (
        target.protocol === 'https:' &&
        target.hostname.endsWith(`.${wildcard[1]}`)
      )
    }
    return target.origin === source
  })
}

function imgSrc(options: Parameters<typeof securityHeaders>[0]): string {
  const csp = directives(securityHeaders(options)['Content-Security-Policy'])
  return csp.get('img-src') ?? ''
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
      securityHeaders({ mediaOrigin: MEDIA })[
        'Content-Security-Policy'
      ],
    )
    expect(csp.get('media-src')).toBe(`'self' ${MEDIA} blob:`)
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

  // Audit 2026-09-22, lead 5: `img-src https:` let any image a page was
  // tricked into rendering — model output, a pasted URL — call any host.
  describe('img-src', () => {
    const options = { mediaOrigin: MEDIA, convexUrl: CONVEX }

    it.each([
      ['the app’s own logo', 'https://app.example/logo.svg'],
      ['an inlined data: image', 'data:image/svg+xml;base64,PHN2Zy8+'],
      [
        'an avatar or logo in Convex storage',
        `${CONVEX}/api/storage/3b0a6c1e-0f5e-4c1a-9d8e-7a1f2b3c4d5e`,
      ],
      ['an image from the media bucket', `${MEDIA}/org/q/1.jpg?X-Amz-Signature=x`],
      [
        'a Google sign-in avatar',
        'https://lh3.googleusercontent.com/a/ACg8ocK=s96-c',
      ],
    ])('loads %s', (_, url) => {
      expect(allows(imgSrc(options), url)).toBe(true)
    })

    it('refuses an image from any other host', () => {
      expect(
        allows(imgSrc(options), 'https://attacker.example/p.png?leak=1'),
      ).toBe(false)
      expect(imgSrc(options).split(' ')).not.toContain('https:')
    })

    it('still loads Convex storage when the deployment URL has a path', () => {
      const sources = imgSrc({ convexUrl: `${CONVEX}/` })
      expect(allows(sources, `${CONVEX}/api/storage/x`)).toBe(true)
    })
  })

  // Audit 2026-09-22, h10: MEDIA_ORIGIN was spliced into the CSP as typed.
  describe('a malformed deployment origin', () => {
    it.each([
      ['a directive after a semicolon', `${MEDIA}; script-src *`],
      ['a semicolon inside the host', 'https://interw-media;script-src'],
      ['a quote inside the host', "https://interw-media'unsafe-eval'"],
      ['a line break', `${MEDIA}\r\nX-Injected: 1`],
      ['a wildcard', 'https://*.scw.cloud'],
      ['plain http', 'http://interw-media.s3.fr-par.scw.cloud'],
    ])('is dropped when it carries %s', (_, value) => {
      const headers = securityHeaders({ mediaOrigin: value, convexUrl: value })
      const csp = headers['Content-Security-Policy']
      expect(csp).not.toMatch(/[\r\n]/)
      const parsed = directives(csp)
      expect([...parsed.keys()]).toEqual([
        'default-src',
        'script-src',
        'style-src',
        'img-src',
        'font-src',
        'connect-src',
        'media-src',
        'frame-ancestors',
        'base-uri',
        'form-action',
      ])
      expect(parsed.get('media-src')).toBe("'self' https: blob:")
      expect(parsed.get('img-src')).toBe(
        "'self' data: https://*.googleusercontent.com",
      )
    })

    it('drops a media origin with a path, which is not an origin', () => {
      const csp = directives(
        securityHeaders({ mediaOrigin: `${MEDIA}/bucket` })[
          'Content-Security-Policy'
        ],
      )
      expect(csp.get('media-src')).toBe("'self' https: blob:")
    })

    it('accepts http on loopback, for a local Convex backend', () => {
      expect(
        allows(
          imgSrc({ convexUrl: 'http://127.0.0.1:3210' }),
          'http://127.0.0.1:3210/api/storage/x',
        ),
      ).toBe(true)
    })
  })
})
