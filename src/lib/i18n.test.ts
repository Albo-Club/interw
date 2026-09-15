import { describe, expect, it } from 'vitest'

import { NAMESPACES, resources } from './i18n'

/**
 * The previous Interw shipped 9 of 13 namespaces empty and 7 of 184 components
 * translated: the cost of i18n was paid and the benefit never collected. These
 * tests make that outcome a red build rather than a slow drift.
 */

type Tree = { [key: string]: string | Tree }

function flatten(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>()
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') out.set(path, value)
    else for (const [k, v] of flatten(value, path)) out.set(k, v)
  }
  return out
}

const locales = ['en', 'fr'] as const

describe('i18n resources', () => {
  it.each(NAMESPACES)('namespace "%s" exists in every locale', (namespace) => {
    for (const locale of locales) {
      expect(resources[locale]).toHaveProperty(namespace)
    }
  })

  it.each(NAMESPACES)('namespace "%s" has the same keys in en and fr', (ns) => {
    const en = flatten(resources.en[ns])
    const fr = flatten(resources.fr[ns])
    expect({
      missingInFr: [...en.keys()].filter((k) => !fr.has(k)).sort(),
      missingInEn: [...fr.keys()].filter((k) => !en.has(k)).sort(),
    }).toEqual({ missingInFr: [], missingInEn: [] })
  })

  it.each(NAMESPACES)('namespace "%s" has no blank value', (ns) => {
    for (const locale of locales) {
      const blanks = [...flatten(resources[locale][ns])]
        .filter(([, value]) => value.trim() === '')
        .map(([key]) => key)
      expect({ locale, blanks }).toEqual({ locale, blanks: [] })
    }
  })

  // An interpolation placeholder present in one locale and not the other
  // renders as a literal `{{count}}` to whoever speaks the other language.
  it.each(NAMESPACES)('namespace "%s" uses the same placeholders', (ns) => {
    const en = flatten(resources.en[ns])
    const fr = flatten(resources.fr[ns])
    const placeholders = (value: string) =>
      [...value.matchAll(/\{\{(\w+)[^}]*\}\}/g)].map((m) => m[1]).sort()

    const mismatches: Array<string> = []
    for (const [key, value] of en) {
      const other = fr.get(key)
      if (other === undefined) continue
      if (placeholders(value).join(',') !== placeholders(other).join(',')) {
        mismatches.push(key)
      }
    }
    expect(mismatches).toEqual([])
  })
})
