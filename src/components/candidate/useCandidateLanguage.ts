import { useEffect, useSyncExternalStore } from 'react'
import { useTranslation } from 'react-i18next'
import type { Locale } from '~/lib/locale'
import { isLocale } from '~/lib/locale'

/**
 * The candidate surface speaks the role's language, not the browser's —
 * unless the candidate picks the other one.
 *
 * A French role opened in an English browser used to wrap French questions in
 * an English interface. The role is what the candidate was invited to, in the
 * language of the invitation email; the browser setting is an accident. A
 * choice the candidate makes with the switcher is not an accident, so it wins
 * for the rest of the tab.
 *
 * Returns false until the switch has happened, so a screen can keep its
 * skeleton rather than flash the other language for a frame. The cookie is
 * left alone: this is one link's language, not the visitor's preference.
 */
export function useCandidateLanguage(language: Locale | undefined): boolean {
  const { i18n } = useTranslation()
  const chosen = useSyncExternalStore(subscribe, readChoice, () => null)
  const effective = language === undefined ? undefined : (chosen ?? language)
  useEffect(() => {
    if (!effective) return
    document.documentElement.lang = effective
    if (i18n.language !== effective) void i18n.changeLanguage(effective)
  }, [i18n, effective])
  return effective === undefined || i18n.language === effective
}

/** The switcher's side: remember the choice for this tab and apply it. */
export function chooseCandidateLanguage(language: Locale): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, language)
  } catch {
    // Storage refused (private mode, policy): the choice lasts until
    // the page reloads.
  }
  choice = language
  for (const listener of listeners) listener()
}

const STORAGE_KEY = 'interw.candidate.language'
const listeners = new Set<() => void>()
let choice: Locale | null | undefined

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function readChoice(): Locale | null {
  if (choice === undefined) {
    let stored: string | null = null
    try {
      stored = sessionStorage.getItem(STORAGE_KEY)
    } catch {
      // Unreadable storage is the same as no choice.
    }
    choice = isLocale(stored) ? stored : null
  }
  return choice
}
