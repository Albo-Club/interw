import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'

export type CandidateScreen =
  | 'welcome'
  | 'check'
  | 'interview'
  | 'done'
  | 'privacy'

/**
 * A candidate screen's own title and description. The layout route keeps
 * `noindex` and `no-referrer`; this only says which screen the tab is on.
 */
export function candidateHead(screen: CandidateScreen) {
  const t = getI18n(getLocale()).getFixedT(null, 'interview')
  return {
    meta: [
      { title: t(`screens.${screen}.title`) },
      { name: 'description', content: t(`screens.${screen}.description`) },
    ],
  }
}
