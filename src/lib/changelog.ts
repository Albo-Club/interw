// In-app changelog ("What's new") entry metadata, newest first. The
// user-facing copy lives in the `changelog` i18n namespace, keyed by `id` —
// add the entry here AND in src/locales/{en,fr}/changelog.json.
export const CHANGELOG_ENTRIES = [
  { id: 'sign-in-with-a-code', date: '2026-09-24' },
  { id: 'verification-link-guidance', date: '2026-09-24' },
  { id: 'sturdier-interview', date: '2026-09-24' },
  { id: 'verification-needs-password', date: '2026-09-24' },
  { id: 'job-import-pinned', date: '2026-09-24' },
  { id: 'erasure-reaches-copies', date: '2026-09-24' },
  { id: 'candidate-interview-hardening', date: '2026-09-24' },
  { id: 'team-access-hardening', date: '2026-09-24' },
  { id: 'assistant-images-and-role-actions', date: '2026-09-24' },
  { id: 'abuse-hardening', date: '2026-09-24' },
  { id: 'assistant-in-europe', date: '2026-09-22' },
  { id: 'role-authoring-fixes', date: '2026-09-17' },
  { id: 'european-ai', date: '2026-09-16' },
  { id: 'reliable-reports', date: '2026-09-16' },
  { id: 'report-sharing', date: '2026-09-14' },
  { id: 'async-interviews', date: '2026-09-14' },
] as const

export const LATEST_CHANGELOG_ID = CHANGELOG_ENTRIES[0].id
