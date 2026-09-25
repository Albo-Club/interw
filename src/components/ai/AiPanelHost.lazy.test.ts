// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'

/**
 * Audit 2026-09-15, E8: the org layout imported the AI panel statically, and
 * with it the markdown renderer — 131 KB gzip, 80 % of the recruiter
 * layout's weight — fetched before the first paint of every recruiter page,
 * panel open or not. `streamdown` is what the panel costs, so the proof is
 * that loading the layout never loads it.
 */
const loaded = vi.hoisted(() => ({ streamdown: false }))
vi.mock('streamdown', () => {
  loaded.streamdown = true
  return {}
})

describe('the recruiter layout', () => {
  it('does not load the markdown renderer until the panel opens', async () => {
    await import('~/routes/app/$orgSlug/route')
    expect(loaded.streamdown).toBe(false)
  })
})
