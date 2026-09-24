import type { SessionGateState } from '../../../convex/lib/sessionState'
import { convexErrorCode, errorMessageKey } from '~/lib/convex-errors'
import { classifyMediaError } from '~/lib/media/devices'

/** A closed or unknown link, as the candidate copy names it (`interview:state.*`). */
export type LinkState = 'notFound' | 'expired' | 'closed' | 'cancelled' | 'completed'

/**
 * Every state the server can refuse a link with. Typed against the gate, so a
 * state added there fails to compile here instead of reaching the crash
 * screen.
 */
const STATES: Record<
  Exclude<SessionGateState, 'ready' | 'resumable'> | 'not_found',
  LinkState
> = {
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
  return code !== null && code in STATES
    ? STATES[code as keyof typeof STATES]
    : null
}

/** The i18n key for a failure on the candidate surface, device or server. */
export function candidateErrorKey(cause: unknown): string {
  const media = classifyMediaError(cause)
  return media
    ? `interview:device.${media}`
    : errorMessageKey(cause, 'interview').key
}
