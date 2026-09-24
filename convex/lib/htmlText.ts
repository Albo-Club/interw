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

/**
 * A reference past U+10FFFF or to a surrogate is not a character, and
 * String.fromCodePoint throws on the first. HTML decodes both to U+FFFD.
 */
function fromCodePoint(code: number): string {
  return code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
    ? '\uFFFD'
    : String.fromCodePoint(code)
}

function decodeEntities(input: string): string {
  return input
    .replace(/&#(\d+);/g, (_, code: string) => fromCodePoint(Number(code)))
    .replace(/&#[xX]([0-9a-fA-F]+);/g, (_, code: string) =>
      fromCodePoint(parseInt(code, 16)),
    )
    .replace(/&([a-zA-Z]+);/g, (match, name: string) =>
      name.toLowerCase() in ENTITIES ? ENTITIES[name.toLowerCase()] : match,
    )
}

/**
 * The most either function below will parse: what the job-ad fetcher accepts
 * (MAX_PAGE_BYTES in convex/jobImportFetch.ts). Stated here as well so the
 * work this module does is bounded by the module, not by its caller.
 */
const PARSE_BUDGET = 2 * 1024 * 1024

type Span = { start: number; openEnd: number; closeStart: number; end: number }

/**
 * Every `open … close` span, left to right; `closeStart` is -1 for an opener
 * with no closer, whose span is the opener alone.
 *
 * Not a lazy `open[\s\S]*?close` regex: that rescans to the end of the input
 * from every unclosed opener, which is quadratic on a page of them. Here the
 * search for a missing closer runs once — if none follows one opener, none
 * follows a later one either. Both regexes must carry the `g` flag.
 */
function spans(text: string, open: RegExp, close: RegExp): Array<Span> {
  const found: Array<Span> = []
  let closerLeft = true
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const openEnd = open.lastIndex
    close.lastIndex = openEnd
    const c: RegExpExecArray | null = closerLeft ? close.exec(text) : null
    closerLeft = c !== null
    if (!c) {
      found.push({ start: m.index, openEnd, closeStart: -1, end: openEnd })
      continue
    }
    found.push({ start: m.index, openEnd, closeStart: c.index, end: close.lastIndex })
    open.lastIndex = close.lastIndex
  }
  return found
}

/** Each span becomes a single space; an unclosed opener loses the opener only. */
function dropSpans(text: string, open: RegExp, close: RegExp): string {
  let out = ''
  let last = 0
  for (const span of spans(text, open, close)) {
    out += text.slice(last, span.start) + ' '
    last = span.end
  }
  return out + text.slice(last)
}

/**
 * Tags → whitespace, entities → characters, runs of blank lines collapsed.
 * Block-level tags become newlines so list items and headings do not run
 * into each other, which is what turns a requirements list into mush.
 *
 * Tag classes are `[^<>]`, not `[^>]`: a match attempt then stops at the next
 * `<`, so a page of openers with no `>` costs linear time, not quadratic.
 */
export function htmlToText(html: string, maxLength = 12_000): string {
  let text = html.slice(0, PARSE_BUDGET)

  // An unclosed <head>/<nav> etc. loses its opener only; dropping to the end
  // would swallow the rest of the page.
  for (const tag of DROPPED_ELEMENTS) {
    text = dropSpans(
      text,
      new RegExp(`<${tag}\\b[^<>]*>`, 'gi'),
      new RegExp(`</${tag}\\s*>`, 'gi'),
    )
  }
  text = dropSpans(text, /<!--/g, /-->/g)

  text = text
    .replace(/<\/?(p|div|section|article|br|li|tr|h[1-6]|ul|ol|table)\b[^<>]*>/gi, '\n')
    .replace(/<[^<>]+>/g, ' ')

  return decodeEntities(text)
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLength)
}

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

  const source = html.slice(0, PARSE_BUDGET)
  const blocks = spans(
    source,
    /<script\b[^<>]*type=["']application\/ld\+json["'][^<>]*>/gi,
    /<\/script\s*>/gi,
  )

  for (const { openEnd, closeStart } of blocks) {
    if (closeStart === -1) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(source.slice(openEnd, closeStart).trim())
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
