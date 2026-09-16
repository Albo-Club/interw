import { describe, expect, it } from 'vitest'

import { assertPublicHttpUrl, isPrivateHost } from './safeUrl'

/**
 * This table is the specification of what "import a job ad" refuses to fetch.
 * A URL that reaches this deployment's network reaches whatever the
 * deployment can reach, and its content comes back summarised by a model — so
 * the channel is readable, not just reachable.
 *
 * Several of these look like they cannot matter until you try them. The WHATWG
 * URL parser normalises `http://2130706433/` to `127.0.0.1` for us, and would
 * have defeated a naive check that only looked for a leading `127.`; it does
 * nothing at all for `100.64.0.1`, `[::ffff:7f00:1]` or `printer.local`.
 */
const REFUSED: Array<[string, string]> = [
  ['loopback', 'http://127.0.0.1/'],
  ['loopback, another octet', 'http://127.99.1.2/'],
  ['loopback by name', 'http://localhost/'],
  ['loopback by name, with a port', 'http://localhost:9000/x'],
  ['a subdomain of localhost', 'http://api.localhost/'],
  ['decimal notation', 'http://2130706433/'],
  ['hexadecimal notation', 'http://0x7f000001/'],
  ['octal notation', 'http://0177.0.0.1/'],
  ['the unspecified address', 'http://0.0.0.0/'],
  ['the 0.0.0.0/8 block', 'http://0.1.2.3/'],
  ['RFC 1918, ten', 'http://10.0.0.5/'],
  ['RFC 1918, one-seven-two', 'http://172.20.3.4/'],
  ['RFC 1918, one-nine-two', 'http://192.168.1.1/'],
  ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
  ['CGNAT', 'http://100.64.0.1/'],
  ['CGNAT, upper end', 'http://100.127.255.254/'],
  ['multicast', 'http://239.1.1.1/'],
  ['IPv6 loopback', 'http://[::1]/'],
  ['IPv6 unspecified', 'http://[::]/'],
  ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/'],
  ['IPv4-mapped IPv6, written in hex', 'http://[::ffff:7f00:1]/'],
  ['IPv4-mapped IPv6 hiding metadata', 'http://[::ffff:169.254.169.254]/'],
  ['IPv6 unique local', 'http://[fd12:3456::1]/'],
  ['IPv6 link-local', 'http://[fe80::1]/'],
  ['mDNS', 'http://printer.local/'],
  ['cloud-internal suffix', 'http://db.internal/'],
  ['home.arpa', 'http://router.home.arpa/'],
  ['credentials in the URL', 'http://user:pass@example.com/'],
  ['a non-http scheme', 'file:///etc/passwd'],
  ['another non-http scheme', 'gopher://example.com/'],
  ['data', 'data:text/html,hi'],
  ['not a URL at all', 'not a url'],
  ['empty', ''],
]

const ALLOWED: Array<[string, string]> = [
  ['an ordinary https page', 'https://example.com/jobs/42'],
  ['plain http', 'http://example.com/jobs/42'],
  ['a public address written as a literal', 'https://93.184.216.34/'],
  ['a public IPv6 literal', 'https://[2606:2800:220:1:248:1893:25c8:1946]/'],
  // `nip.io` resolves to a loopback address, but it IS a public name. The
  // lexical check cannot know; convex/jobImportFetch.ts resolves it and
  // refuses it there.
  ['a name that resolves privately', 'http://127.0.0.1.nip.io/'],
]

describe('assertPublicHttpUrl', () => {
  it.each(REFUSED)('refuses %s', (_name, url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow('invalid_url')
  })

  it.each(ALLOWED)('allows %s', (_name, url) => {
    expect(() => assertPublicHttpUrl(url)).not.toThrow()
  })
})

/**
 * The same predicate runs again in jobImportFetch.ts, over the addresses a
 * hostname resolves to — which is what catches `127.0.0.1.nip.io`.
 */
describe('isPrivateHost, as applied to a resolved address', () => {
  it.each([
    ['127.0.0.1', true],
    ['169.254.169.254', true],
    ['10.1.2.3', true],
    ['100.64.9.9', true],
    ['::1', true],
    ['fd00::1', true],
    ['::ffff:10.0.0.1', true],
    ['93.184.216.34', false],
    ['2606:2800:220:1:248:1893:25c8:1946', false],
    ['8.8.8.8', false],
    ['99.64.0.1', false],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
  ] as Array<[string, boolean]>)('%s → %s', (address, expected) => {
    expect(isPrivateHost(address)).toBe(expected)
  })
})
