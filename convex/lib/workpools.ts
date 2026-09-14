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
import type { WorkpoolComponent } from '@convex-dev/workpool'

/**
 * `convex/_generated/api.d.ts` lists a component only after `convex dev` (or
 * `convex codegen`) has run against a deployment, and codegen needs one. The
 * two pools below are registered in `convex/convex.config.ts`; this narrowing
 * is the single place that bridges the gap until the next codegen regenerates
 * that file, at which point it becomes a no-op and can be deleted.
 * See KNOWN_ISSUES.md § "Workpool components and committed codegen".
 */
const registered = components as typeof components & {
  mediaWorkpool: WorkpoolComponent
  reportWorkpool: WorkpoolComponent
}

/** Retry budget shared by both pools: ~2s, 4s, 8s, then give up and surface. */
const RETRY = { maxAttempts: 4, initialBackoffMs: 2_000, base: 2 } as const

/**
 * Transcription — one job per answered question, so it bursts when a candidate
 * finishes. Parallelism is deliberately modest: the cap is per deployment
 * across every pool (20 on the free plan, 100 on Pro), and starving the report
 * pool would delay exactly the thing the recruiter is waiting for.
 */
export const mediaPool = new Workpool(registered.mediaWorkpool, {
  maxParallelism: 5,
  retryActionsByDefault: true,
  defaultRetryBehavior: RETRY,
})

/** Report, para-verbal and notification — one long job per session. */
export const reportPool = new Workpool(registered.reportWorkpool, {
  maxParallelism: 3,
  retryActionsByDefault: true,
  defaultRetryBehavior: RETRY,
})
