import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { Locale } from '~/lib/locale'

/**
 * The candidate surface speaks the role's language, not the browser's.
 *
 * A French role opened in an English browser used to wrap French questions in
 * an English interface. The role is what the candidate was invited to, in the
 * language of the invitation email; the browser setting is an accident.
 *
 * Returns false until the switch has happened, so a screen can keep its
 * skeleton rather than flash the other language for a frame. The cookie is
 * left alone: this is one link's language, not the visitor's preference.
 */
export function useCandidateLanguage(language: Locale | undefined): boolean {
  const { i18n } = useTranslation()
  useEffect(() => {
    if (!language) return
    document.documentElement.lang = language
    if (i18n.language !== language) void i18n.changeLanguage(language)
  }, [i18n, language])
  return language === undefined || i18n.language === language
}
