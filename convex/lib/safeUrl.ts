/**
 * Deciding whether a URL a user typed may be fetched from inside our
 * infrastructure.
 *
 * "Import a job ad" hands a recruiter's URL to the server and fetches it. That
 * is a server-side request forgery primitive: the request comes from the
 * deployment, not from the recruiter's laptop, so it reaches whatever the
 * deployment can reach. The output is then summarised by a model and handed
 * back, which makes the channel readable as well as reachable.
 *
 * Pure and exported so the list of what we refuse is a table of cases rather
 * than a paragraph of intent. The network half — resolving the host and
 * re-checking every redirect — lives in convex/jobImportFetch.ts, which needs
 * Node's resolver.
 *
 * On its own this closes the static class — literal addresses in every
 * notation. A hostname like `127.0.0.1.nip.io` that resolves somewhere
 * private, or a record that changes between the check and the connection, is
 * jobImportFetch.ts's to refuse: it checks every resolved address with
 * `isPrivateAddress` and connects only to the ones that passed.
 */

/** Expand an IPv6 host to its eight 16-bit groups, or null if it is not one. */
function parseIpv6(host: string): Array<number> | null {
  if (!/^[0-9a-f:.]+$/i.test(host) || !host.includes(':')) return null
  const parts = host.split('::')
  // At most one `::` run, by definition.
  if (parts.length > 2) return null
  const head = parts[0]
  const tail: string | null = parts.length === 2 ? parts[1] : null

  const expand = (part: string): Array<number> | null => {
    if (!part) return []
    const groups: Array<number> = []
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        // A trailing dotted quad, as in `::ffff:127.0.0.1`.
        const quad = parseIpv4(piece)
        if (!quad) return null
        groups.push((quad[0] << 8) | quad[1], (quad[2] << 8) | quad[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null
      groups.push(parseInt(piece, 16))
    }
    return groups
  }

  const left = expand(head)
  if (!left) return null
  if (tail === null) return left.length === 8 ? left : null
  const right = expand(tail)
  if (!right) return null
  const gap = 8 - left.length - right.length
  if (gap < 0) return null
  return [...left, ...Array<number>(gap).fill(0), ...right]
}

/** Parse a dotted-quad IPv4 host, or null. */
function parseIpv4(host: string): Array<number> | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: Array<number> = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    octets.push(value)
  }
  return octets
}

function isPrivateIpv4([a, b]: Array<number>): boolean {
  if (a === 0) return true // "this network", and 0.0.0.0 means every local address
  if (a === 10) return true
  if (a === 127) return true // loopback
  if (a === 169 && b === 254) return true // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true // CGNAT
  if (a >= 224) return true // multicast and reserved
  return false
}

/** An IPv4 address carried in two 16-bit IPv6 groups, judged as IPv4. */
function isPrivateEmbeddedIpv4(high: number, low: number): boolean {
  return isPrivateIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff])
}

function isPrivateIpv6(groups: Array<number>): boolean {
  const isZero = groups.slice(0, 7).every((group) => group === 0)
  if (isZero && groups[7] === 1) return true // ::1, loopback
  if (isZero && groups[7] === 0) return true // ::, unspecified
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible: judge the v4 inside.
  if (groups.slice(0, 5).every((group) => group === 0)) {
    if (groups[5] === 0xffff || groups[5] === 0) {
      return isPrivateEmbeddedIpv4(groups[6], groups[7])
    }
  }
  const [first, second] = groups
  // NAT64 and 6to4 hand the packet to an IPv4 address: judge that one too.
  if (first === 0x64 && second === 0xff9b) {
    if (groups[2] === 1) return true // 64:ff9b:1::/48, local-use NAT64
    if (groups.slice(2, 6).every((group) => group === 0)) {
      return isPrivateEmbeddedIpv4(groups[6], groups[7]) // 64:ff9b::/96
    }
  }
  if (first === 0x2002) return isPrivateEmbeddedIpv4(second, groups[2]) // 6to4
  if ((first & 0xfe00) === 0xfc00) return true // fc00::/7, unique local
  if ((first & 0xffc0) === 0xfe80) return true // fe80::/10, link-local
  if ((first & 0xff00) === 0xff00) return true // ff00::/8, multicast
  return false
}

/** Hostnames that never belong to the public internet. */
const PRIVATE_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
  '.localdomain',
]

/**
 * Whether this host — a literal address in any notation, or a name — must not
 * be reached. Also used on the addresses a host resolves to.
 */
export function isPrivateHost(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/^\[|\]$/g, '')
  if (!host) return true

  const v4 = parseIpv4(host)
  if (v4) return isPrivateIpv4(v4)
  const v6 = parseIpv6(host)
  if (v6) return isPrivateIpv6(v6)

  if (host === 'localhost') return true
  return PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/**
 * Whether an address a hostname resolved to must not be connected to.
 * Stricter than `isPrivateHost`, which has to let names through: an answer
 * that is not a well-formed address is one we cannot vouch for, so it fails.
 */
export function isPrivateAddress(address: string): boolean {
  const v4 = parseIpv4(address)
  if (v4) return isPrivateIpv4(v4)
  const v6 = parseIpv6(address)
  return v6 ? isPrivateIpv6(v6) : true
}

/**
 * The URL, if it is one we are willing to fetch. Throws `invalid_url`
 * otherwise — the same error for every reason, because the caller is telling
 * us where to go and owes no explanation of what we can see.
 */
export function assertPublicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('invalid_url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('invalid_url')
  }
  // Credentials in the URL are a redirect-laundering trick and are never
  // needed to read a public job ad.
  if (url.username || url.password) throw new Error('invalid_url')
  if (isPrivateHost(url.hostname)) throw new Error('invalid_url')
  return url
}
