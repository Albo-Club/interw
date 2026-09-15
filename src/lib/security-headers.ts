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
 * media origin, the only part that varies per deployment.
 */

/**
 * `mediaOrigin` is the origin the signed media URLs point at (the object
 * store bucket, e.g. `https://interw-media.s3.fr-par.scw.cloud`). Left unset,
 * `media-src` falls back to `https:` — the same posture `img-src` and
 * `connect-src` already take — so a deployment that has not wired the
 * variable plays video instead of failing silently.
 */
export function securityHeaders(mediaOrigin?: string): Record<string, string> {
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
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self' https: wss:",
      // Recordings are served from the bucket by signed URL, and previews are
      // `blob:` URLs built in the browser. Without this directive both fall
      // back to `default-src 'self'` and nothing plays, anywhere.
      `media-src 'self' ${mediaOrigin ?? 'https:'} blob:`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; '),
  }
}
