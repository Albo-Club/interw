import { Outlet, createFileRoute } from '@tanstack/react-router'

import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import {
  CandidateError,
  CandidateNotFound,
} from '~/components/candidate/CandidateError'

/**
 * The candidate surface.
 *
 * Its own layout route so it shares nothing with the recruiter app — no
 * sidebar, no org context, no AI panel. An ESLint rule (see eslint.config.mjs)
 * keeps it that way at the import level, which is what actually holds the
 * bundle down; a convention would not have.
 *
 * `noindex` is not optional: these URLs are personal to one candidate, and a
 * crawler finding one would put an interview in a search result.
 */
export const Route = createFileRoute('/s/$token')({
  component: CandidateLayout,
  // The candidate's own fallbacks, never the back office's: its "Go home"
  // button led a candidate holding a dead link to the marketing site.
  errorComponent: CandidateError,
  notFoundComponent: CandidateNotFound,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'interview')('metaTitle'),
      },
      { name: 'robots', content: 'noindex, nofollow' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
})

function CandidateLayout() {
  return <Outlet />
}
