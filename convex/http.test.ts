/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { describe, expect, it, vi } from 'vitest'

import schema from './schema'

// Better Auth mounts its own routes through its component, which `convex-test`
// does not run. Nothing below depends on them.
vi.mock('./auth', () => ({
  authComponent: {
    safeGetAuthUser: () => Promise.resolve(null),
    getAuthUser: () => Promise.reject(new Error('Unauthenticated')),
    registerRoutes: () => {},
  },
  createAuth: () => ({}),
}))

const modules = import.meta.glob('./**/*.ts')

describe('http router', () => {
  // Fingerprint: convex/chat.ts:streamOverHttp:chatSend-limiter-bypass
  // POST /api/chat reached the paid agent without the per-user chatSend
  // budget every in-app path pays, and minted a thread per request. Nothing
  // in the app called it; the in-app chat is sendMessage + listMessages.
  it('does not expose a chat generation endpoint', async () => {
    const t = convexTest(schema, modules)
    const response = await t.fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orgId: 'x', prompt: 'hello' }),
    })
    expect(response.status).toBe(404)
  })
})
