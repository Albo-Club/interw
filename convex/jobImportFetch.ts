'use node'

/**
 * Fetching a URL a recruiter typed, from inside our infrastructure, safely.
 *
 * Node runtime on purpose, and it is the only reason this is a separate
 * module: checking where a hostname actually points needs a resolver, and the
 * default Convex runtime has none. `convex/jobImport.ts` keeps its query and
 * its action in the fast runtime and calls this.
 *
 * Four things the lexical check in lib/safeUrl.ts cannot do on its own:
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
 *   pin — checking a name and then handing the name to `fetch` resolved it
 *     twice, so whoever controls the record could answer the check with a
 *     public address and the connection with `127.0.0.1`. Each hop now
 *     connects only to the addresses its own check approved, while the name
 *     still travels as the `Host` header and the TLS server name — the
 *     certificate is verified against the name, exactly as before. That is
 *     why this uses `node:http(s)` and not `fetch`: its `lookup` option is
 *     how Node lets us choose the address, with no second copy of undici to
 *     keep in step with the one inside Node.
 */

import { lookup } from 'node:dns/promises'
import { get as httpGet } from 'node:http'
import { get as httpsGet } from 'node:https'
import { ConvexError, v } from 'convex/values'

import { internalAction } from './_generated/server'
import {
  assertPublicHttpUrl,
  isPrivateAddress,
  isPrivateHost,
} from './lib/safeUrl'
import type { LookupFunction } from 'node:net'
import type { IncomingMessage } from 'node:http'
import type { LookupAddress } from 'node:dns'

const FETCH_TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 5
/** Enough for any job ad; `htmlToText` keeps 12 000 characters of it anyway. */
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const ALLOWED_CONTENT_TYPES = ['text/html', 'application/xhtml+xml', 'text/plain']

/**
 * Node's `fetch` sends no `User-Agent` at all, and a good share of job boards
 * refuse an anonymous client outright — the recruiter then reads "check the
 * link" about a link that was correct. Identify the product and where to
 * complain about it rather than impersonating a browser: that clears the sites
 * that only filter unidentified clients, and the ones that refuse every
 * non-browser now say so as `page_blocked`.
 */
const USER_AGENT = `InterwBot/1.0 (+${
  process.env.SITE_URL ?? 'https://interw.app'
})`

/** What a browser asks for. A bare `text/html` earns a 406 from some servers. */
const ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

/** Where `url` points, once every address it resolves to is public. */
async function resolvePublicly(url: URL): Promise<Array<LookupAddress>> {
  // A literal address needs no lookup, and `lookup` on one just echoes it.
  if (isPrivateHost(url.hostname)) throw new ConvexError('invalid_url')
  let addresses: Array<LookupAddress>
  try {
    addresses = await lookup(url.hostname, { all: true })
  } catch {
    throw new ConvexError('page_unreachable')
  }
  if (addresses.length === 0) throw new ConvexError('page_unreachable')
  // Every address, not the first: a name that answers with one public and one
  // private address is the interesting case, not an accident.
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) throw new ConvexError('invalid_url')
  }
  return addresses
}

/**
 * A resolver that answers every question with the addresses already checked.
 * Node asks for `all` of them when it races IPv4 against IPv6.
 */
function pinnedLookup(addresses: Array<LookupAddress>): LookupFunction {
  return (_hostname, { all, family }, callback) => {
    const matching = addresses.filter((a) => !family || a.family === family)
    // Answer later, as a real lookup does: `http` only starts listening for
    // the socket's errors after it asked, so a synchronous answer whose
    // connection fails at once throws past every handler.
    setImmediate(() => {
      if (matching.length === 0) {
        const error: NodeJS.ErrnoException = new Error('no checked address')
        error.code = 'ENOTFOUND'
        callback(error, [])
      } else if (all) {
        callback(null, matching)
      } else {
        callback(null, matching[0].address, matching[0].family)
      }
    })
  }
}

function open(url: URL, addresses: Array<LookupAddress>) {
  const get = url.protocol === 'https:' ? httpsGet : httpGet
  return new Promise<IncomingMessage>((resolve, reject) => {
    get(
      url,
      {
        // A connection of its own: a pooled socket was opened for some other
        // request, to addresses this hop never checked.
        agent: false,
        lookup: pinnedLookup(addresses),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: {
          Accept: ACCEPT,
          // Nothing here decompresses, so the size cap counts what we read.
          'Accept-Encoding': 'identity',
          'User-Agent': USER_AGENT,
        },
      },
      resolve,
    ).on('error', reject)
  })
}

async function readCapped(response: IncomingMessage): Promise<string> {
  const chunks: Array<Buffer> = []
  let size = 0
  for await (const chunk of response as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    // Stop pulling rather than read to the end and throw it away.
    if (size > MAX_PAGE_BYTES) throw new ConvexError('page_too_large')
    chunks.push(chunk)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
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
      const response = await open(current, await resolvePublicly(current))
      try {
        const status = response.statusCode ?? 0

        if (status >= 300 && status < 400) {
          const location = response.headers.location
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

        // The site answered, and the answer is "not you". Worth its own code:
        // "that page could not be read, check the link" sends a recruiter
        // hunting for a typo in a URL that is perfectly good.
        if ([401, 403, 429].includes(status)) {
          throw new ConvexError('page_blocked')
        }
        if (status < 200 || status >= 300) {
          throw new ConvexError('page_unreachable')
        }

        // The `Accept` header is a request, not a guarantee. A response that
        // is not markup is either not a job ad or not meant for us.
        const contentType = (response.headers['content-type'] ?? '')
          .split(';')[0]
          .trim()
          .toLowerCase()
        if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
          throw new ConvexError('page_unreachable')
        }

        return await readCapped(response)
      } finally {
        // Whatever this hop did not read — a redirect, a refusal, a page past
        // the cap — releases its socket now, not when the timeout fires.
        response.destroy()
      }
    }
    throw new ConvexError('page_unreachable')
  },
})
