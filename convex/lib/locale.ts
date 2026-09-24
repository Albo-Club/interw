// Locale negotiation, shared by the web server (`src/lib/locale.ts`) and the
// Convex auth handlers. Pure: no framework import, so both runtimes can load it.

export type AppLocale = 'en' | 'fr'

/**
 * Resolve a locale from an Accept-Language header (or a single navigator tag).
 * English is the default; French wins only when a French variant (fr, fr-CA,
 * fr-BE, …) is the highest-priority language the client asked for.
 */
export function localeFromAcceptLanguage(
  header: string | null | undefined,
): AppLocale {
  if (!header) return 'en'
  const ranked = header
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';')
      const qParam = params.find((p) => p.trim().startsWith('q='))
      const q = qParam ? Number.parseFloat(qParam.split('=')[1]) : 1
      return { tag: tag.toLowerCase(), q: Number.isFinite(q) ? q : 1 }
    })
    .sort((a, b) => b.q - a.q)

  for (const { tag } of ranked) {
    if (tag === 'fr' || tag.startsWith('fr-')) return 'fr'
    if (tag === 'en' || tag.startsWith('en-')) return 'en'
  }
  return 'en'
}

/**
 * The language a request is being read in: the `lang` cookie the web app
 * writes (the switcher, or the server's first negotiation), else the browser's
 * Accept-Language. For an email sent before the recipient has a stored
 * preference — above all the very first sign-in code.
 */
export function localeFromHeaders(headers: Headers | null | undefined): AppLocale {
  const cookie = headers?.get('cookie')?.match(/(?:^|;\s*)lang=(en|fr)\b/)
  if (cookie) return cookie[1] as AppLocale
  return localeFromAcceptLanguage(headers?.get('accept-language'))
}
