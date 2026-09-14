/**
 * The two work pools that carry an interview from "candidate finished" to
 * "recruiter has a report".
 *
 * Every step is idempotent — each job checks at entry whether its result
 * already exists — so the pool may retry any of them safely. That property is
 * what replaces the catch-up scripts the previous build needed: if a step can
 * fail, the queue picks it up again. There is no repair function anywhere in
 * this codebase, by design.
 */

import { Workpool } from '@convex-dev/workpool'

import { components } from '../_generated/api'

/** Retry budget shared by both pools: ~2s, 4s, 8s, then give up and surface. */
const RETRY = { maxAttempts: 4, initialBackoffMs: 2_000, base: 2 } as const

/**
 * Transcription — one job per answered question, so it bursts when a candidate
 * finishes. Parallelism is deliberately modest: the cap is per deployment
 * across every pool (20 on the free plan, 100 on Pro), and starving the report
 * pool would delay exactly the thing the recruiter is waiting for.
 */
export const mediaPool = new Workpool(components.mediaWorkpool, {
  maxParallelism: 5,
  retryActionsByDefault: true,
  defaultRetryBehavior: RETRY,
})

/** Report, para-verbal and notification — one long job per session. */
export const reportPool = new Workpool(components.reportWorkpool, {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: RETRY,
})
