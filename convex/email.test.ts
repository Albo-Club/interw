import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The guard runs when the module loads, so every case needs a fresh import
 * with its own environment.
 */
async function loadEmailModule(env: Record<string, string>) {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value)
  return await import('./email')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

describe('Resend test mode', () => {
  it('refuses to load on a public site URL', async () => {
    await expect(
      loadEmailModule({
        SITE_URL: 'https://interw-staging.vercel.app',
        RESEND_TEST_MODE: 'true',
      }),
    ).rejects.toThrow(/RESEND_TEST_MODE/)
  })

  it('leaves local development alone', async () => {
    await expect(
      loadEmailModule({
        SITE_URL: 'http://localhost:3000',
        RESEND_TEST_MODE: 'true',
      }),
    ).resolves.toBeDefined()
  })

  it('loads on a public site URL once test mode is off', async () => {
    await expect(
      loadEmailModule({
        SITE_URL: 'https://interw-staging.vercel.app',
        RESEND_TEST_MODE: 'false',
      }),
    ).resolves.toBeDefined()
  })
})
