import '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { convexBetterAuthReactStart } from '@convex-dev/better-auth/react-start'

import { withPlatformClientIp } from '../../../../convex/lib/clientIp'

const ba = convexBetterAuthReactStart({
  convexUrl: import.meta.env.VITE_CONVEX_URL,
  convexSiteUrl: import.meta.env.VITE_CONVEX_SITE_URL,
})

// The Convex Better Auth adapter calls `fetch(upstream, { body: req.body,
// duplex: 'half' })` to proxy the request. On Vercel's Node runtime, that
// streaming-body path throws on POST /sign-in/email and surfaces as a 500
// to the browser even though Convex itself returns a clean 401.
// Buffering the body to an ArrayBuffer first turns the request into a
// non-streaming one, which `fetch` handles reliably on every runtime.
// The adapter forwards every header as-is; the client IP Better Auth rate-limits
// on is replaced by the one the platform observed (convex/lib/clientIp.ts).
async function upstreamRequest(request: Request): Promise<Request> {
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const body = hasBody ? await request.arrayBuffer() : undefined
  return new Request(request.url, {
    method: request.method,
    headers: withPlatformClientIp(request.headers),
    body: body && body.byteLength > 0 ? body : undefined,
  })
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      ANY: async ({ request }) => {
        try {
          return await ba.handler(await upstreamRequest(request))
        } catch (err) {
          // Log fields on separate lines: Vercel's UI truncates a single
          // long line, which hid the actual cause during the first round.
          // The path only: the query string of a sign-in, verification or
          // reset link carries its token.
          console.error(
            '[ts-auth-handler] path=',
            new URL(request.url).pathname,
          )
          console.error('[ts-auth-handler] method=', request.method)
          console.error(
            '[ts-auth-handler] name=',
            err instanceof Error ? err.name : typeof err,
          )
          console.error(
            '[ts-auth-handler] message=',
            err instanceof Error ? err.message : String(err),
          )
          if (err instanceof Error && err.stack) {
            console.error('[ts-auth-handler] stack=', err.stack)
          }
          throw err
        }
      },
    },
  },
})
