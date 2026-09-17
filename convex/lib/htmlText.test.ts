import { describe, expect, it } from 'vitest'

import { htmlToText, jobPostingText } from './htmlText'

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

describe('jobPostingText', () => {
  // The shape Welcome to the Jungle and every other client-rendered board
  // serves: a shell with nothing readable in it, and the whole ad in JSON-LD
  // so Google for Jobs can index it.
  const shell = (ld: string) =>
    `<html><head><script type="application/ld+json">${ld}</script></head>` +
    `<body><nav>Jobs</nav><div id="root"></div></body></html>`

  it('reads the ad a JS shell only publishes as JSON-LD', () => {
    const html = shell(
      JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'JobPosting',
        title: 'Développeur Full-Stack',
        hiringOrganization: { '@type': 'Organization', name: 'Doctolib' },
        description: '<p>Vous rejoindrez</p><ul><li>React</li></ul>',
      }),
    )
    // The stripped markup has nothing in it; the JSON-LD has the ad.
    expect(htmlToText(html)).not.toContain('React')
    const text = jobPostingText(html)
    expect(text).toContain('Développeur Full-Stack')
    expect(text).toContain('Doctolib')
    expect(text).toContain('Vous rejoindrez')
    expect(text).toContain('React')
    expect(text).not.toContain('<p>')
  })

  it('finds the posting inside an @graph', () => {
    const html = shell(
      JSON.stringify({
        '@graph': [
          { '@type': 'WebSite', name: 'Board' },
          { '@type': 'JobPosting', title: 'Data Analyst', description: 'SQL' },
        ],
      }),
    )
    expect(jobPostingText(html)).toContain('Data Analyst')
  })

  it('ignores blocks that are not a posting', () => {
    const html = shell(
      JSON.stringify([
        { '@type': 'BreadcrumbList', name: 'Home' },
        {
          '@type': ['JobPosting'],
          title: 'Product Manager',
          description: 'Roadmap',
        },
      ]),
    )
    const text = jobPostingText(html)
    expect(text).toContain('Product Manager')
    expect(text).not.toContain('Home')
  })

  it('skips malformed JSON-LD instead of throwing', () => {
    // A board shipping broken JSON-LD must not take the import down with it —
    // the stripped markup is still there to fall back on.
    expect(jobPostingText(shell('{ not json'))).toBe('')
  })

  it('returns nothing for a page that carries no posting', () => {
    expect(jobPostingText('<html><body><p>A blog post</p></body></html>')).toBe(
      '',
    )
  })
})
