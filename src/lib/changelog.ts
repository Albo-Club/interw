import en from '~/locales/en/changelog-entries.json'
import fr from '~/locales/fr/changelog-entries.json'

// In-app changelog ("What's new") entry metadata, newest first. The copy of
// each entry is keyed by `id` in src/locales/{en,fr}/changelog-entries.json —
// add the entry here AND in both files.
export const CHANGELOG_ENTRIES = [
  { id: 'invitations-hardening', date: '2026-09-25' },
  { id: 'role-access-tightened', date: '2026-09-25' },
  { id: 'candidate-emails-job-title', date: '2026-09-25' },
  { id: 'share-highlights-and-deadlines', date: '2026-09-25' },
  { id: 'assistant-history-purged', date: '2026-09-25' },
  { id: 'auth-hardening-sep-25', date: '2026-09-25' },
  { id: 'removed-members-credit', date: '2026-09-25' },
  { id: 'calmer-interface', date: '2026-09-25' },
  { id: 'candidate-leave-guard', date: '2026-09-25' },
  { id: 'data-correctness', date: '2026-09-25' },
  { id: 'backend-hardening', date: '2026-09-25' },
  { id: 'interview-survives-crash', date: '2026-09-25' },
  { id: 'recordings-play-everywhere', date: '2026-09-25' },
  { id: 'delete-organization', date: '2026-09-25' },
  { id: 'assistant-panel', date: '2026-09-24' },
  { id: 'recruiter-routes', date: '2026-09-24' },
  { id: 'candidate-page', date: '2026-09-24' },
  { id: 'candidate-table', date: '2026-09-24' },
  { id: 'video-intro', date: '2026-09-24' },
  { id: 'role-team', date: '2026-09-24' },
  { id: 'evaluation-hardening', date: '2026-09-24' },
  { id: 'delivery-figures-removed', date: '2026-09-24' },
  { id: 'clearer-account-settings', date: '2026-09-24' },
  { id: 'team-invitations', date: '2026-09-24' },
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

type EntryCopy = { title: string; body: string }
const ENTRY_COPY: Record<'en' | 'fr', Record<string, EntryCopy>> = {
  en,
  fr,
}

/**
 * The title and body of one entry. Not in the i18n resources: those are
 * bundled into every page, the candidate's interview included, and this copy
 * grows with every release. Importing it here keeps it in the recruiter
 * chunks that show it. See KNOWN_ISSUES.md § "The candidate bundle budget".
 */
export function entryCopy(id: string, language: string): EntryCopy {
  return ENTRY_COPY[language.startsWith('fr') ? 'fr' : 'en'][id]
}
