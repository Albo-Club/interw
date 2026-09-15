import { describe, expect, it } from 'vitest'

import { htmlToText } from './htmlText'

describe('htmlToText', () => {
  it('drops scripts and styles entirely, content included', () => {
    const text = htmlToText(
      '<style>.a{color:red}</style><p>Hello</p><script>alert("x")</script>',
    )
    expect(text).toBe('Hello')
  })

  it('turns block tags into newlines so a list does not run together', () => {
    // Adjacent block boundaries give a blank line, which reads fine and keeps
    // a requirements list from collapsing into one sentence.
    expect(htmlToText('<ul><li>React</li><li>TypeScript</li></ul>')).toBe(
      'React\n\nTypeScript',
    )
  })

  it('decodes the entities a French job ad is full of', () => {
    expect(htmlToText('<p>D&eacute;veloppeur exp&eacute;riment&eacute;</p>')).toBe(
      'Développeur expérimenté',
    )
    expect(htmlToText('<p>R&#233;f&#xE9;rence</p>')).toBe('Référence')
  })

  it('leaves an unknown entity alone rather than mangling it', () => {
    expect(htmlToText('<p>A &notarealentity; B</p>')).toBe(
      'A &notarealentity; B',
    )
  })

  it('collapses whitespace and blank-line runs', () => {
    expect(htmlToText('<p>A</p>\n\n\n\n<p>B</p>')).toBe('A\n\nB')
  })

  // An unclosed <nav> used to swallow the rest of the document.
  it('survives an unclosed dropped element', () => {
    expect(htmlToText('<nav><p>Menu</p><p>Job description here</p>')).toContain(
      'Job description here',
    )
  })

  it('truncates to the cap', () => {
    expect(htmlToText(`<p>${'a'.repeat(500)}</p>`, 100)).toHaveLength(100)
  })
})
