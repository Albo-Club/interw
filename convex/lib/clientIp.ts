/**
 * The one header Better Auth reads a client IP from (`advanced.ipAddress` in
 * convex/auth.ts), for its per-IP rate limits and the sessions list. Set only
 * by the web server's auth proxy (`src/routes/api/auth/$.ts`), from the
 * address its platform observed. A name no platform or ingress sets, so what
 * Convex does with `X-Forwarded-For` never decides which bucket a user is in.
 * See KNOWN_ISSUES.md § "Brute force: the IP is a claim, the account is not".
 */
export const CLIENT_IP_HEADER = 'x-interw-client-ip'

/**
 * The headers to send upstream: every client-supplied IP header dropped, and
 * the platform's client IP in `CLIENT_IP_HEADER`. On Vercel the edge
 * overwrites `X-Forwarded-For` with the address it saw, so what arrives here
 * is the platform's word, not the client's.
 */
export function withPlatformClientIp(incoming: Headers): Headers {
  const headers = new Headers(incoming)
  const ip = incoming.get('x-forwarded-for')?.trim()
  for (const name of ['x-forwarded-for', 'x-real-ip', CLIENT_IP_HEADER])
    headers.delete(name)
  if (ip) headers.set(CLIENT_IP_HEADER, ip)
  return headers
}
