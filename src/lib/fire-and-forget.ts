/**
 * For the calls whose failure genuinely must not interrupt the user.
 *
 * "No swallowed errors" is a rule with one honest exception: a diagnostic
 * write, a telemetry event, an autoplay attempt. A candidate must not lose
 * their interview because an event log 500'd. But `.catch(() => undefined)`
 * is still a swallow, so this gives the exception a name and a console trace —
 * the failure is non-blocking, not invisible.
 *
 * Anything a user needs to know about does NOT belong here. If in doubt, it
 * does not belong here.
 */
export function fireAndForget(
  promise: Promise<unknown>,
  label: string,
): void {
  void promise.catch((error: unknown) => {
    console.warn(`[interw] ${label} failed (non-blocking)`, error)
  })
}
