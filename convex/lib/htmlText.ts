/**
 * Plain text out of an HTML page, for the "import a job ad" flow.
 *
 * Deliberately not a scraping service. The previous build paid a third party
 * to turn a URL into markdown; a job ad is a page of prose, and stripping tags
 * well enough for a language model to read is about forty lines. One fewer
 * vendor, one fewer key, one fewer thing that can be down at 9am.
 */

/** Elements whose content is never prose. */
const DROPPED_ELEMENTS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'head',
  'nav',
  'footer',
  'iframe',
]

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  eacute: 'é',
  egrave: 'è',
  agrave: 'à',
  ccedil: 'ç',
  ocirc: 'ô',
  ecirc: 'ê',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  laquo: '«',
  raquo: '»',
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, code: string) =>
      String.fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (match, name: string) =>
      name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : match,
    )
}

/**
 * Tags → whitespace, entities → characters, runs of blank lines collapsed.
 * Block-level tags become newlines so list items and headings do not run
 * into each other, which is what turns a requirements list into mush.
 */
export function htmlToText(html: string, maxLength = 12_000): string {
  let text = html

  for (const tag of DROPPED_ELEMENTS) {
    text = text.replace(
      new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\s*>`, 'gi'),
      ' ',
    )
    // Unclosed <head>/<nav> etc. would otherwise swallow the rest of the page.
    text = text.replace(new RegExp(`<${tag}\\b[^>]*/?>`, 'gi'), ' ')
  }

  text = text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?(p|div|section|article|br|li|tr|h[1-6]|ul|ol|table)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')

  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}
