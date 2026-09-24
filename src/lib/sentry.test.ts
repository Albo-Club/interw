import { describe, expect, it } from 'vitest'

import { scrubCandidateTokens } from './sentry'

const token = 'tDRtkHnQY0MiWduSUxuwcZUMacZvWgtpEqZ88H_Uf-J'

/** E10. The token left the browser in every event from the candidate surface. */
describe('scrubCandidateTokens', () => {
  it('masks the token wherever it appears in an event', () => {
    const event = {
      request: { url: `https://interw.com/s/${token}/interview?camera=x` },
      transaction: `/s/${token}/interview`,
      breadcrumbs: [
        { category: 'navigation', data: { from: `/s/${token}`, to: `/s/${token}/check` } },
      ],
    }
    const scrubbed = JSON.stringify(scrubCandidateTokens(event))
    expect(scrubbed).not.toContain(token)
    expect(scrubCandidateTokens(event).request.url).toBe(
      'https://interw.com/s/[token]/interview?camera=x',
    )
  })

  it('leaves other paths alone', () => {
    const event = { request: { url: 'https://interw.com/app/acme/roles' } }
    expect(scrubCandidateTokens(event)).toEqual(event)
  })
})
