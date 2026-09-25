import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Trans } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import { createI18n } from './i18n'

const render = (orgName: string) =>
  renderToStaticMarkup(
    createElement(Trans, {
      i18n: createI18n('en'),
      i18nKey: 'auth:acceptInvite.summary',
      values: { inviter: 'Mallory', orgName, role: 'member' },
    }),
  )

// T12: `escapeValue` is off (React escapes text), but <Trans> parses the
// interpolated string for tags, so a name someone typed became markup. No
// prop here: the protection is the instance's default, on every <Trans>.
describe('<Trans> with a value someone typed', () => {
  it('renders an org name full of tags as the text it is', () => {
    const html = render('<strong>Acme</strong><0>x</0>')
    expect(html).toContain('<strong>&lt;strong&gt;Acme&lt;/strong&gt;&lt;0&gt;x')
  })

  it('shows apostrophes and ampersands once, not double-escaped', () => {
    expect(render("O'Brien & Co")).toContain('O&#x27;Brien &amp; Co')
  })
})
