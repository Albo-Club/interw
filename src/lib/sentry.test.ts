/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'

import { scrubAccessTokens } from './sentry'
import source from './sentry.ts?raw'

const token = 'tDRtkHnQY0MiWduSUxuwcZUMacZvWgtpEqZ88H_Uf-J'

/** E10. The token left the browser in every event from the candidate surface. */
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

  // h10: a share link opens the report and signs URLs on the video.
  it('masks a report share token the same way', () => {
    const event = {
      request: { url: `https://interw.com/r/${token}` },
      breadcrumbs: [{ category: 'fetch', data: { url: `/r/${token}?x=1` } }],
    }
    const scrubbed = scrubAccessTokens(event)
    expect(JSON.stringify(scrubbed)).not.toContain(token)
    expect(scrubbed.request.url).toBe('https://interw.com/r/[token]')
  })

  // A role's public link opens a new session on the role to whoever holds it.
  it('masks a public apply token the same way', () => {
    const event = { request: { url: `https://interw.com/apply/${token}` } }
    expect(scrubAccessTokens(event).request.url).toBe(
      'https://interw.com/apply/[token]',
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

// h10: a replay option with no replay integration is inert today, and one
// "completion" away from recording the interview screen for a third party.
it('sets no session-replay option', () => {
  expect(source).not.toMatch(/replays\w*SampleRate/)
})
