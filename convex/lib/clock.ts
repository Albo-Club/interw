/**
 * The clock an authorisation decision is allowed to use.
 *
 * A Convex query is reactive: it re-runs when the data it read changes, and
 * not when the wall clock moves. That is why the token surfaces take `now` as
 * an argument — passing the browser's clock is what makes a link visibly stop
 * working the moment it expires, without polling.
 *
 * The mistake is letting that argument decide the authorisation. `now` comes
 * from whoever holds the link, so `view({ token, now: 0 })` used to resurrect
 * an expired share and mint an hour of signed URLs on the candidate's video.
 *
 * `effectiveNow` keeps the reactivity and takes back the decision: an honest
 * client passes roughly the server's clock and gets its own value, so the
 * query still re-runs on each tick it sends; a client that reaches into the
 * past gets the server's clock instead. The tolerance absorbs genuine skew
 * between a browser and the deployment — it is not a grace period, and it is
 * deliberately far smaller than any expiry this product issues.
 *
 * An action has the server's clock and no reactivity to preserve, so it must
 * not use this: it passes `Date.now()` and ignores what it was handed.
 */

/** How far behind the server a client's clock may claim to be. */
const MAX_SKEW_MS = 60_000

export function effectiveNow(clientNow: number): number {
  return Math.max(clientNow, Date.now() - MAX_SKEW_MS)
}
