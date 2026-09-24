// @vitest-environment node
/// <reference types="vite/client" />
import dns from 'node:dns'
import { createServer } from 'node:http'
import { createServer as createTlsServer } from 'node:tls'
import { convexTest } from 'convex-test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { internal } from './_generated/api'
import schema from './schema'
import type { AddressInfo, Server } from 'node:net'
import type { IncomingHttpHeaders } from 'node:http'
import type * as SafeUrl from './lib/safeUrl'

/**
 * DNS rebinding, reproduced without leaving the machine. The check and the
 * connection each resolve the hostname; an attacker who controls the record
 * answers the first with a public address and the second with an internal
 * one. The fetch must connect to the address the check approved, never to
 * whatever a second resolution says.
 */

// The resolver the check uses.
const checkLookup = vi.hoisted(() => vi.fn())
vi.mock('node:dns/promises', () => ({ lookup: checkLookup }))

// Two loopback addresses stand in for "a public server", so that the address
// that passes the check can be one this machine answers on. Everything else
// is judged by the real predicate.
const PUBLIC_STAND_INS = ['127.0.0.1', '::1']
vi.mock('./lib/safeUrl', async (importOriginal) => {
  const actual = await importOriginal<typeof SafeUrl>()
  return {
    ...actual,
    isPrivateAddress: (address: string) =>
      !PUBLIC_STAND_INS.includes(address) && actual.isPrivateAddress(address),
  }
})

const modules = import.meta.glob('./**/*.ts')

const PAGE = '<html><body>the job ad</body></html>'
const INTERNAL = '<html><body>internal secret</body></html>'

const servers: Array<Server> = []

afterEach(async () => {
  vi.restoreAllMocks()
  checkLookup.mockReset()
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  )
})

async function listen(server: Server): Promise<number> {
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

/** A loopback page server, recording what reached it. */
async function pageServer(body: string) {
  const seen: Array<IncomingHttpHeaders> = []
  const port = await listen(
    createServer((req, res) => {
      seen.push(req.headers)
      res.writeHead(200, { 'content-type': 'text/html' }).end(body)
    }),
  )
  return { port, seen }
}

/**
 * What the connection would resolve to, if it resolved on its own. Set after
 * the servers listen, since `listen` resolves its host through the same call.
 */
function connectResolvesTo(address: string, family: 4 | 6) {
  vi.spyOn(dns, 'lookup').mockImplementation(((
    _host: string,
    options: unknown,
    callback: (...args: Array<unknown>) => void,
  ) => {
    const done = typeof options === 'function' ? options : callback
    if ((options as { all?: boolean }).all) {
      done(null, [{ address, family }])
    } else {
      done(null, address, family)
    }
  }) as unknown as typeof dns.lookup)
}

function fetchPage(url: string) {
  return convexTest(schema, modules).action(
    internal.jobImportFetch.fetchJobPage,
    { url },
  )
}

describe('fetchJobPage connects to the address it checked', () => {
  it('does not follow a rebinding to an internal address', async () => {
    const inside = await pageServer(INTERNAL)
    // Check: a stand-in public address, with nothing listening on it.
    checkLookup.mockResolvedValue([{ address: '::1', family: 6 }])
    // Connection: the internal service.
    connectResolvesTo('127.0.0.1', 4)

    const outcome = await fetchPage(
      `http://rebind.example:${inside.port}/`,
    ).catch((error: unknown) => error)

    expect(outcome).not.toBe(INTERNAL)
    expect(inside.seen).toHaveLength(0)
  })

  it('reaches the checked address, and still names the host', async () => {
    const page = await pageServer(PAGE)
    checkLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    // Were the connection to resolve on its own, it would go nowhere.
    connectResolvesTo('::1', 6)

    await expect(
      fetchPage(`http://jobs.example:${page.port}/ad`),
    ).resolves.toBe(PAGE)
    expect(page.seen).toHaveLength(1)
    expect(page.seen[0].host).toBe(`jobs.example:${page.port}`)
  })

  it('checks every redirect hop, and connects to none it refused', async () => {
    const inside = await pageServer(INTERNAL)
    const port = await listen(
      createServer((_req, res) => {
        res
          .writeHead(302, {
            location: `http://internal.example:${inside.port}/`,
          })
          .end()
      }),
    )
    checkLookup.mockImplementation((host: string) =>
      Promise.resolve([
        {
          address: host === 'jobs.example' ? '127.0.0.1' : '10.0.0.1',
          family: 4,
        },
      ]),
    )
    connectResolvesTo('127.0.0.1', 4)

    await expect(fetchPage(`http://jobs.example:${port}/`)).rejects.toThrow(
      'invalid_url',
    )
    expect(inside.seen).toHaveLength(0)
  })

  it('stops reading past the size cap', async () => {
    const huge = await pageServer('x'.repeat(2 * 1024 * 1024 + 1))
    checkLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    // Were the connection to resolve on its own, it would go nowhere.
    connectResolvesTo('::1', 6)

    await expect(
      fetchPage(`http://jobs.example:${huge.port}/`),
    ).rejects.toThrow('page_too_large')
  })

  it.each([
    [403, 'text/html', 'page_blocked'],
    [500, 'text/html', 'page_unreachable'],
    [200, 'application/json', 'page_unreachable'],
  ])(
    'lets go of the connection at once on %s %s',
    async (status, contentType, code) => {
      let closed!: Promise<void>
      // Headers, then a body that never ends: only our side can close this.
      const port = await listen(
        createServer((req, res) => {
          closed = new Promise((resolve) => req.socket.on('close', resolve))
          res.writeHead(status, { 'content-type': contentType }).write('...')
        }),
      )
      checkLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
      connectResolvesTo('::1', 6)

      await expect(fetchPage(`http://jobs.example:${port}/`)).rejects.toThrow(
        code,
      )
      // Well before the 15 s timeout would have closed it for us.
      await expect(
        Promise.race([
          closed.then(() => 'closed'),
          new Promise((resolve) => setTimeout(resolve, 1000, 'still open')),
        ]),
      ).resolves.toBe('closed')
    },
  )

  it('offers the hostname for TLS, so the certificate is checked against it', async () => {
    let servername: string | undefined
    const port = await listen(
      createTlsServer({
        SNICallback: (name, callback) => {
          servername = name
          // No certificate: the handshake stops here, which is all we need.
          callback(new Error('test server has no certificate'))
        },
      }),
    )
    checkLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
    // Were the connection to resolve on its own, it would go nowhere.
    connectResolvesTo('::1', 6)

    await expect(fetchPage(`https://jobs.example:${port}/`)).rejects.toThrow()
    expect(servername).toBe('jobs.example')
  })
})
