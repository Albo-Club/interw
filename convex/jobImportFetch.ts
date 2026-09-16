'use node'

/**
 * Fetching a URL a recruiter typed, from inside our infrastructure, safely.
 *
 * Node runtime on purpose, and it is the only reason this is a separate
 * module: checking where a hostname actually points needs a resolver, and the
 * default Convex runtime has none. `convex/jobImport.ts` keeps its query and
 * its action in the fast runtime and calls this.
 *
 * Three things the lexical check in lib/safeUrl.ts cannot do on its own:
 *
 *   resolve — `http://127.0.0.1.nip.io/` is a perfectly ordinary public
 *     hostname that answers with a loopback address. The name passes; what it
 *     points at does not.
 *   follow — the old code validated the URL it was given and then let `fetch`
 *     follow redirects unchecked, so `https://attacker.example/x` answering
 *     `302 Location: http://169.254.169.254/latest/meta-data/` walked straight
 *     past the check. Every hop is now validated as if it had been typed.
 *   stop — `response.text()` materialises the whole body before
 *     `htmlToText` truncates it, so a URL answering with a few hundred
 *     megabytes took the action's memory with it.
 *
 * What none of this closes: an attacker who controls a DNS record and moves it
 * between our resolution and our connection. Fixing that means connecting to
 * the address we checked, which `fetch` does not let us choose.
 */

import { lookup } from 'node:dns/promises'
import { ConvexError, v } from 'convex/values'

import { internalAction } from './_generated/server'
import { assertPublicHttpUrl, isPrivateHost } from './lib/safeUrl'

const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
/** Enough for any job ad; `htmlToText` keeps 12 000 characters of it anyway. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain']

async function assertResolvesPublicly(url: URL): Promise<void> {
  // A literal address needs no lookup, and `lookup` on one just echoes it.
  if (isPrivateHost(url.hostname)) throw new ConvexError('invalid_url')
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(url.hostname, { all: true })
  } catch {
    throw new ConvexError('page_unreachable')
  }
  if (addresses.length === 0) throw new ConvexError('page_unreachable')
  // Every address, not the first: a name that answers with one public and one
  // private address is the interesting case, not an accident.
  for (const { address } of addresses) {
    if (isPrivateHost(address)) throw new ConvexError('invalid_url')
  }
}

async function readCapped(response: Response): Promise<string> {
  const body = response.body
  if (!body) return ''
  const reader = body.getReader()
  const chunks: Array<Uint8Array> = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_PAGE_BYTES) {
        // Stop pulling rather than read to the end and throw it away.
        await reader.cancel()
        throw new ConvexError('page_too_large')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  return new TextDecoder().decode(
    chunks.reduce<Uint8Array>((all, chunk) => {
      const merged = new Uint8Array(all.length + chunk.length)
      merged.set(all)
      merged.set(chunk, all.length)
      return merged
    }, new Uint8Array(0)),
  )
}

export const fetchJobPage = internalAction({
  args: { url: v.string() },
  handler: async (_ctx, { url: raw }): Promise<string> => {
    let current: URL
    try {
      current = assertPublicHttpUrl(raw)
    } catch {
      throw new ConvexError('invalid_url')
    }

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertResolvesPublicly(current)

      const response = await fetch(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { Accept: 'text/html,application/xhtml+xml' },
      })

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        if (!location) throw new ConvexError('page_unreachable')
        let next: URL
        try {
          // Resolved against the current URL, then checked from scratch — a
          // relative redirect is still a redirect.
          next = assertPublicHttpUrl(new URL(location, current).toString())
        } catch {
          throw new ConvexError('invalid_url')
        }
        current = next
        continue
      }

      if (!response.ok) throw new ConvexError('page_unreachable')

      // The `Accept` header is a request, not a guarantee. A response that is
      // not markup is either not a job ad or not meant for us.
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        .trim()
        .toLowerCase()
      if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
        throw new ConvexError('page_unreachable')
      }

      return await readCapped(response)
    }
    throw new ConvexError('page_unreachable')
  },
})
