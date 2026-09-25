import { describe, expect, it } from 'vitest'

import { CHANGELOG_ENTRIES, ENTRY_COPY, LATEST_CHANGELOG_ID } from './changelog'

/**
 * Audit 2026-09-15, B10: the two Interw entries were written at the top level
 * of `changelog.json` instead of under `entries`, so the dialog and the page
 * rendered `entries.report-sharing.title` — the raw key — as the headline of
 * the newest release. i18n parity did not catch it: both locales were wrong
 * in the same way.
 *
 * The metadata and the copy live in two files keyed by the same id; nothing
 * but a test keeps them together.
 */

const locales = ['en', 'fr'] as const

describe('changelog', () => {
  it.each(locales)('every entry has a title and a body in %s', (locale) => {
    const entries: Record<string, unknown> = ENTRY_COPY[locale]
    const missing = CHANGELOG_ENTRIES.filter(({ id }) => {
      const entry = entries[id] as { title?: string; body?: string } | undefined
      return !entry?.title || !entry.body
    }).map(({ id }) => id)
    expect(missing).toEqual([])
  })

  it.each(locales)('%s has no copy for an entry that is gone', (locale) => {
    const ids = new Set<string>(CHANGELOG_ENTRIES.map(({ id }) => id))
    const orphans = Object.keys(ENTRY_COPY[locale]).filter(
      (id) => !ids.has(id),
    )
    expect(orphans).toEqual([])
  })

  it('is ordered newest first', () => {
    const dates = CHANGELOG_ENTRIES.map(({ date }) => date)
    expect(dates).toEqual([...dates].sort().reverse())
    expect(LATEST_CHANGELOG_ID).toBe(CHANGELOG_ENTRIES[0].id)
  })
})
