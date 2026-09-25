/**
 * The security headers served on every response, as plain data.
 *
 * They live here rather than inline in `src/start.ts` so a unit test can hold
 * them. Two of these strings decide whether the product works at all —
 * `Permissions-Policy` gates `getUserMedia`, `media-src` gates video playback
 * — and both were wrong for the whole of the first build. See KNOWN_ISSUES.md
 * § "The template's Permissions-Policy denied the camera to the app itself".
 *
 * Pure module: no environment read, no server import. The caller passes the
 * media and Convex origins, the only parts that vary per deployment.
 */

/**
 * The origin of `value`, or `undefined` unless it is an `https:` URL whose
 * host is plain letters, digits, dots and hyphens.
 *
 * Deployment variables are spliced into the CSP. The URL parser alone lets
 * `https://host;x` through with `;x` in the origin, which appends a directive
 * of the operator's typo; a CR/LF would make every response fail header
 * validation. `http:` is accepted on loopback only, for a local Convex
 * backend.
 */
function cspOrigin(value: string | undefined): string | undefined {
  if (!value || !URL.canParse(value)) return undefined
  const { protocol, hostname, origin } = new URL(value)
  if (!/^[a-z0-9.-]+$/.test(hostname)) return undefined
  const loopback = hostname === 'localhost' || hostname === '127.0.0.1'
  return protocol === 'https:' || (protocol === 'http:' && loopback)
    ? origin
    : undefined
}

/**
 * - `mediaOrigin` is the origin the signed media URLs point at (the object
 *   store bucket, e.g. `https://interw-media.s3.fr-par.scw.cloud`), and must
 *   be exactly that — an origin, nothing after it. Left unset or malformed,
 *   `media-src` falls back to `https:`, so a deployment that has not wired
 *   the variable plays video instead of failing silently.
 * - `convexUrl` is the deployment URL; its origin serves Convex file storage,
 *   which is where avatars and organisation logos resolve
 *   (`<deployment>.convex.cloud/api/storage/…`).
 */
export function securityHeaders({
  mediaOrigin,
  convexUrl,
}: {
  mediaOrigin?: string
  convexUrl?: string
} = {}): Record<string, string> {
  const media =
    cspOrigin(mediaOrigin) === mediaOrigin ? mediaOrigin : undefined
  // Images are the one outbound request a page makes on render, with
  // whatever the URL carries: only the hosts that actually serve ours.
  // Google serves the avatar of an account created with Google sign-in.
  const imageHosts = [
    "'self'",
    'data:',
    cspOrigin(convexUrl),
    media,
    'https://*.googleusercontent.com',
  ].filter(Boolean)
  return {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
    // `camera=()` is an EMPTY allowlist: it denies the capability to the
    // document itself, not just to third parties. The candidate records
    // video and audio from this origin, so both are granted to `self` — and
    // to nobody else, which is what the empty list was reaching for.
    'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()',
    // CSP: allow inline styles (Tailwind), scripts from self (TanStack
    // bundles), connections to Convex (the deployment is the only
    // cross-origin target). Tighten further per deployment if you don't use
    // Sentry/analytics.
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src ${imageHosts.join(' ')}`,
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      // Recordings are served from the bucket by signed URL, and previews are
      // `blob:` URLs built in the browser. Without this directive both fall
      // back to `default-src 'self'` and nothing plays, anywhere.
      `media-src 'self' ${media ?? 'https:'} blob:`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  }
}
