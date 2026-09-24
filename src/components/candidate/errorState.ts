import { convexErrorCode } from '~/lib/convex-errors'

/** A closed or unknown link, as the candidate copy names it (`interview:state.*`). */
export type LinkState = 'notFound' | 'expired' | 'closed' | 'cancelled' | 'completed'

const STATES: Record<string, LinkState> = {
  not_found: 'notFound',
  expired: 'expired',
  closed: 'closed',
  cancelled: 'cancelled',
  completed: 'completed',
}

/**
 * Whether an error thrown on the candidate surface is a state of the link
 * rather than a crash.
 *
 * An unknown token, a closed role or a finished interview all arrive as a
 * thrown `ConvexError` from a reactive query. Treated as crashes, they showed
 * the back office's "Something went wrong" with a "Go home" button to the
 * marketing site — and sent the candidate's token to Sentry during normal
 * operation.
 */
export function linkStateFromError(error: unknown): LinkState | null {
  const code = convexErrorCode(error)
  return code !== null && code in STATES ? STATES[code] : null
}
