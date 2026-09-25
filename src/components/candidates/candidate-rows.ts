/**
 * The candidate table's rules, kept out of the component so they can be
 * tested: what a filter keeps, how a column sorts, and which invitations
 * never reached their candidate.
 */

import type { FunctionReturnType } from 'convex/server'

import type { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'

export type CandidateRow = FunctionReturnType<
  typeof api.sessions.listByProject
>['page'][number]

type EmailEvent = FunctionReturnType<typeof api.emailEvents.recent>[number]

export type DeliveryIssue = 'bounced' | 'complained' | 'failed'

export type StatusFilter = CandidateRow['status'] | 'all'
export type DecisionFilter =
  | NonNullable<CandidateRow['recruiterDecision']>
  | 'none'
  | 'all'

export function matchesFilters(
  row: CandidateRow,
  { status, decision }: { status: StatusFilter; decision: DecisionFilter },
): boolean {
  if (status !== 'all' && row.status !== status) return false
  if (decision === 'all') return true
  return (row.recruiterDecision ?? 'none') === decision
}

const RECOMMENDATION_RANK: Record<
  NonNullable<CandidateRow['recommendation']>,
  number
> = { strong_no: 0, no: 1, maybe: 2, yes: 3, strong_yes: 4 }

/**
 * Sort specs, spread into the column definitions. A candidate with no report
 * yet has no score: `undefined` plus `sortUndefined: 'last'` keeps them below
 * every scored candidate in both directions, where `null` would sort as zero
 * and put them on top of an ascending list.
 */
export const SORT_SPECS = {
  candidate: {
    accessorFn: (row: CandidateRow) => row.candidateName.toLocaleLowerCase(),
  },
  score: {
    accessorFn: (row: CandidateRow) => row.overallScore ?? undefined,
    sortUndefined: 'last' as const,
  },
  recommendation: {
    accessorFn: (row: CandidateRow) =>
      row.recommendation ? RECOMMENDATION_RANK[row.recommendation] : undefined,
    sortUndefined: 'last' as const,
  },
  invitedAt: { accessorFn: (row: CandidateRow) => row.invitedAt },
  duration: {
    accessorFn: (row: CandidateRow) => row.durationSeconds ?? undefined,
    sortUndefined: 'last' as const,
  },
}

/**
 * The invitations whose latest send did not reach the candidate. Events come
 * newest first, so the first invitation event seen for a session is its
 * current state: an invitation re-sent and delivered after a bounce clears it.
 */
export function deliveryIssues(
  events: Array<EmailEvent>,
): Map<Id<'sessions'>, DeliveryIssue> {
  const seen = new Set<Id<'sessions'>>()
  const issues = new Map<Id<'sessions'>, DeliveryIssue>()
  for (const event of events) {
    if (event.template !== 'candidate-invitation' || !event.sessionId) continue
    if (seen.has(event.sessionId)) continue
    seen.add(event.sessionId)
    if (
      event.status === 'bounced' ||
      event.status === 'complained' ||
      event.status === 'failed'
    ) {
      issues.set(event.sessionId, event.status)
    }
  }
  return issues
}
