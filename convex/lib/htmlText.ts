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

const LD_JSON =
  /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi

/** Every node of a JSON-LD document, arrays and `@graph` wrappers flattened. */
function ldNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(ldNodes)
  if (typeof value !== 'object' || value === null) return []
  const node = value as Record<string, unknown>
  return [node, ...ldNodes(node['@graph'])]
}

function isJobPosting(node: Record<string, unknown>): boolean {
  const type = node['@type']
  return Array.isArray(type)
    ? type.includes('JobPosting')
    : type === 'JobPosting'
}

/**
 * The schema.org `JobPosting` a board embeds for Google for Jobs, as text.
 *
 * `htmlToText` drops every `<script>`, which on a board that renders its ads
 * client-side — Welcome to the Jungle, Indeed, Workday, most ATS career pages —
 * throws away the only server-rendered copy of the ad and leaves the nav, the
 * cookie banner and little else. That is what `page_too_thin` was firing on.
 *
 * The JSON-LD is reliably there and reliably complete: without it the ad is
 * invisible to Google for Jobs, which is where a board's traffic comes from.
 * It is also cleaner than the rendered page — the ad without the chrome.
 *
 * Returns `''` when the page carries none, which a hand-written ad on a
 * company site usually does; its markup reads fine on its own.
 */
export function jobPostingText(html: string, maxLength = 12_000): string {
  const parts: Array<string> = []

  for (const [, block] of html.matchAll(LD_JSON)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(block.trim())
    } catch {
      // Malformed JSON-LD gets no repair pass. The stripped markup is still
      // there to fall back on, and guessing at what a board meant to publish
      // is how an import invents a role.
      continue
    }
    for (const node of ldNodes(parsed)) {
      if (!isJobPosting(node)) continue
      const organisation = node.hiringOrganization
      const company =
        typeof organisation === 'object' && organisation !== null
          ? (organisation as Record<string, unknown>).name
          : organisation
      // `description` is HTML inside a JSON string on every board that ships
      // one, so it goes back through the tag stripper.
      for (const field of [node.title, company, node.description]) {
        if (typeof field === 'string' && field.trim()) {
          parts.push(htmlToText(field, maxLength))
        }
      }
    }
  }

  return parts.join('\n\n').slice(0, maxLength)
}
