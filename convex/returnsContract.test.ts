import { describe, expect, it } from 'vitest'

import { landing } from './candidate'
import { questions } from './interview'
import { view } from './shares'

/**
 * The projectors in `lib/candidateView.ts` decide what a candidate and a share
 * viewer may see, and they are carefully written — but nothing imposed them.
 * A new function returning a raw document, or one field added to an existing
 * response "just so we can reply to them", would pass review and the type
 * checker alike, and the first sign would be a candidate reading a recruiter's
 * private note.
 *
 * A `returns` validator makes Convex check the value on the way out, so the
 * leak fails at deploy time for whoever introduced it. Every other test in
 * this repo that calls one of these three functions now runs through that
 * check; this one holds the check itself in place, because deleting it would
 * otherwise make nothing fail.
 */
describe('the token-facing surfaces declare a return contract', () => {
  // `exportReturns` is how Convex itself reads the contract at deploy time.
  // It is not on the public `RegisteredQuery` type, hence the cast.
  const contractOf = (fn: unknown) =>
    JSON.parse((fn as { exportReturns: () => string }).exportReturns()) as
      | Record<string, unknown>
      | null

  it.each([
    ['candidate.landing', landing],
    ['interview.questions', questions],
    ['shares.view', view],
  ] as Array<[string, unknown]>)('%s', (_name, fn) => {
    expect(contractOf(fn)).not.toBeNull()
  })
})
