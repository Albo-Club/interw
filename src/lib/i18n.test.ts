import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Trans } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import { jobOutcomeValidator, jobStepValidator } from '../../convex/schema'
import { NAMESPACES, createI18n, resources } from './i18n'

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

/**
 * Carried over from audit T01: `relaunch` and `purge` joined the job log with
 * no label, so the candidate page's pipeline rows could print a raw key.
 * The rows render every step and outcome the log can hold.
 */
describe('pipeline history labels', () => {
  const steps = jobStepValidator.members.map((m) => m.value)
  const outcomes = jobOutcomeValidator.members.map((m) => m.value)

  it.each(locales)('names every job step and outcome in %s', (locale) => {
    const pending = resources[locale].report.pending
    expect({
      steps: steps.filter((step) => !(step in pending.steps)),
      outcomes: outcomes.filter((outcome) => !(outcome in pending.outcome)),
    }).toEqual({ steps: [], outcomes: [] })
  })
})

/**
 * Audit T12 (h10): `<Trans>` parses its interpolated string for tags, so with
 * `escapeValue: false` a name like `<strong>…</strong>` or `<0>…</0>` became
 * markup of its own. Values are escaped for that parse and unescaped once
 * after, so they show as typed — never as markup, never as `&amp;amp;`.
 */
describe('interpolated values in <Trans>', () => {
  const i18n = createI18n('en')
  const render = (values: Record<string, string>) =>
    renderToStaticMarkup(
      createElement(Trans, {
        i18n,
        i18nKey: 'auth:acceptInvite.summary',
        values: { role: 'member', ...values },
      }),
    )

  it('render a value holding tags as text', () => {
    const html = render({
      inviter: 'Eve</strong><strong>Admin',
      orgName: '<0>Acme</0><br/>',
    })
    expect(html).toContain(
      '<strong>Eve&lt;/strong&gt;&lt;strong&gt;Admin</strong>',
    )
    expect(html).toContain('<strong>&lt;0&gt;Acme&lt;/0&gt;&lt;br/&gt;</strong>')
    expect(html).not.toContain('<br')
  })

  it('escape each value exactly once', () => {
    const html = render({ inviter: 'Tom & Jerry', orgName: "O'Brien & Co" })
    expect(html).toContain('<strong>Tom &amp; Jerry</strong>')
    expect(html).toContain('<strong>O&#x27;Brien &amp; Co</strong>')
  })

  it('leave plain t() values alone: React escapes them', () => {
    expect(
      i18n.t('auth:acceptInvite.welcome', { orgName: 'A & B', role: 'x' }),
    ).toBe('You joined A & B as x')
  })
})
