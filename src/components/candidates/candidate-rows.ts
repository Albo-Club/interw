/**
 * The candidate table's rules, kept out of the component so they can be
 * tested: what a filter keeps and how a column sorts.
 */

import type { FunctionReturnType } from 'convex/server'

import type { api } from '../../../convex/_generated/api'

export type CandidateRow = FunctionReturnType<
  typeof api.sessions.listByProject
>['page'][number]

export type DeliveryIssue = NonNullable<CandidateRow['deliveryIssue']>

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
