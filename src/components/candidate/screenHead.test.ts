import { describe, expect, it, vi } from 'vitest'

import { candidateHead } from './screenHead'
import type { CandidateScreen } from './screenHead'
import type { Locale } from '~/lib/locale'

const locale = vi.hoisted((): { current: Locale } => ({ current: 'en' }))
vi.mock('~/lib/locale', () => ({
  DEFAULT_LOCALE: 'en',
  getLocale: () => locale.current,
}))

const SCREENS: Array<CandidateScreen> = [
  'welcome',
  'check',
  'interview',
  'done',
  'privacy',
]

/** Cand M10: five screens shared one title and none had a description. */
describe.each(['en', 'fr'] as const)('candidateHead (%s)', (lang) => {
  it('gives every screen its own title and a description', () => {
    locale.current = lang
    const heads = SCREENS.map((screen) => {
      const [title, description] = candidateHead(screen).meta
      return { title: title.title, description: description.content }
    })
    for (const { title, description } of heads) {
      expect(title).toMatch(/\S/)
      expect(title).not.toMatch(/^screens\./)
      expect(description).toMatch(/\S/)
      expect(description).not.toMatch(/^screens\./)
    }
    expect(new Set(heads.map((head) => head.title)).size).toBe(SCREENS.length)
  })
})
