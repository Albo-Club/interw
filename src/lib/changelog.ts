// In-app changelog ("What's new") entry metadata, newest first. The
// user-facing copy lives in the `changelog` i18n namespace, keyed by `id` —
// add the entry here AND in src/locales/{en,fr}/changelog.json.
export const CHANGELOG_ENTRIES = [
  { id: 'reliable-reports', date: '2026-09-16' },
  { id: 'report-sharing', date: '2026-09-14' },
  { id: 'async-interviews', date: '2026-09-14' },
] as const

export const LATEST_CHANGELOG_ID = CHANGELOG_ENTRIES[0].id
