import { describe, expect, it } from 'vitest'

import { CLIENT_IP_HEADER, withPlatformClientIp } from './clientIp'

describe('the auth proxy headers', () => {
  it('carries the platform client IP in its own header, and no client-set IP header', () => {
    const out = withPlatformClientIp(
      new Headers({
        'x-forwarded-for': '198.51.100.7',
        'x-real-ip': '203.0.113.1',
        [CLIENT_IP_HEADER]: '203.0.113.2',
        cookie: 'a=b',
      }),
    )
    expect(out.get(CLIENT_IP_HEADER)).toBe('198.51.100.7')
    expect(out.get('x-forwarded-for')).toBeNull()
    expect(out.get('x-real-ip')).toBeNull()
    expect(out.get('cookie')).toBe('a=b')
  })

  it('sends no client IP at all rather than one the client chose', () => {
    const out = withPlatformClientIp(
      new Headers({ 'x-real-ip': '203.0.113.1', [CLIENT_IP_HEADER]: '203.0.113.2' }),
    )
    expect(out.get(CLIENT_IP_HEADER)).toBeNull()
    expect(out.get('x-real-ip')).toBeNull()
  })
})
