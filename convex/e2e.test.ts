/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'

const modules = import.meta.glob('./**/*.ts')

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the browser test fixtures', () => {
  it('seed a fresh open session each time, on one org', async () => {
    vi.stubEnv('E2E_FIXTURES', 'enabled')
    const t = newTest()
    const first = await t.mutation(internal.e2e.seedE2eSession, {})
    const second = await t.mutation(internal.e2e.seedE2eSession, {})
    expect(first.token).not.toBe(second.token)

    const landing = await t.query(api.candidate.landing, {
      token: second.token,
      now: Date.now(),
    })
    expect(landing.gate.state).toBe('ready')
    const orgs = await t.run((ctx) => ctx.db.query('organizations').collect())
    expect(orgs).toHaveLength(1)
    expect(
      await t.query(internal.e2e.e2eSessionState, { token: second.token }),
    ).toEqual({ status: 'pending', uploadedSegments: 0 })
  })

  // A deploy key is all `npx convex run` needs, and production has one.
  it.each([undefined, '', 'true', 'production'])(
    'are refused on a deployment that did not opt in (E2E_FIXTURES=%s)',
    async (flag) => {
      vi.stubEnv('E2E_FIXTURES', flag)
      const t = newTest()
      await expect(
        t.mutation(internal.e2e.seedE2eSession, {}),
      ).rejects.toThrow('E2E fixtures are disabled')
      await expect(
        t.query(internal.e2e.e2eSessionState, { token: 'k'.repeat(43) }),
      ).rejects.toThrow('E2E fixtures are disabled')
      const orgs = await t.run((ctx) => ctx.db.query('organizations').collect())
      expect(orgs).toHaveLength(0)
    },
  )
})
