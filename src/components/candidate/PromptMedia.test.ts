import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { PromptMedia } from './PromptMedia'

const render = (kind: 'audio' | 'video') =>
  renderToStaticMarkup(
    createElement(PromptMedia, {
      src: 'https://media.test/q.m4a',
      kind,
      label: 'Q1',
    }),
  )

// Cand F2 (audit 2026-09-15): an audio prompt was rendered in a <video>, a
// black 16:9 box with controls and nothing in it.
describe('PromptMedia', () => {
  it('plays an audio prompt in <audio>', () => {
    const html = render('audio')
    expect(html).toMatch(/^<audio /)
    expect(html).not.toContain('<video')
  })

  it('plays a video prompt in <video>, inline on a phone', () => {
    const html = render('video')
    expect(html).toMatch(/^<video /)
    expect(html).toContain('playsInline')
  })
})
