import { describe, expect, it } from 'vitest'

import { scrubAccessTokens } from './sentry'

const token = 'tDRtkHnQY0MiWduSUxuwcZUMacZvWgtpEqZ88H_Uf-J'

/**
 * E10; audit 2026-09-22, h10. A candidate's or a share holder's token left
 * the browser in every event from the page it opens.
 */
describe('scrubAccessTokens', () => {
  it('masks the token wherever it appears in an event', () => {
    const event = {
      request: { url: `https://interw.com/s/${token}/interview?camera=x` },
      transaction: `/s/${token}/interview`,
      breadcrumbs: [
        { category: 'navigation', data: { from: `/s/${token}`, to: `/s/${token}/check` } },
      ],
    }
    const scrubbed = JSON.stringify(scrubAccessTokens(event))
    expect(scrubbed).not.toContain(token)
    expect(scrubAccessTokens(event).request.url).toBe(
      'https://interw.com/s/[token]/interview?camera=x',
    )
  })

  it('masks a share token in a /r/ report link', () => {
    const event = {
      request: { url: `https://interw.com/r/${token}` },
      transaction: `/r/${token}`,
      breadcrumbs: [
        { category: 'fetch', data: { url: `https://interw.com/r/${token}?x=1` } },
        { category: 'xhr', data: { url: `/r/${token}` } },
      ],
    }
    const scrubbed = JSON.stringify(scrubAccessTokens(event))
    expect(scrubbed).not.toContain(token)
    expect(scrubAccessTokens(event).request.url).toBe(
      'https://interw.com/r/[token]',
    )
  })

  it('masks a sign-in code carried in a /login/code fragment', () => {
    const event = {
      breadcrumbs: [
        {
          category: 'navigation',
          data: { to: '/login/code#email=a%40b.co&code=482913' },
        },
      ],
    }
    const scrubbed = JSON.stringify(scrubAccessTokens(event))
    expect(scrubbed).not.toContain('482913')
    expect(scrubbed).toContain('code=[code]')
  })

  it('leaves other paths alone', () => {
    const event = { request: { url: 'https://interw.com/app/acme/roles' } }
    expect(scrubAccessTokens(event)).toEqual(event)
  })
})
