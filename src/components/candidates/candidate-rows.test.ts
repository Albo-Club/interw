import { describe, expect, it } from 'vitest'
import {
  createTable,
  getCoreRowModel,
  getSortedRowModel,
} from '@tanstack/react-table'

import { SORT_SPECS, deliveryIssues, matchesFilters } from './candidate-rows'
import type { CandidateRow } from './candidate-rows'
import type { SortingState } from '@tanstack/react-table'
import type { Id } from '../../../convex/_generated/dataModel'

const sid = (n: number) => `session_${n}` as Id<'sessions'>

function row(n: number, patch: Partial<CandidateRow> = {}): CandidateRow {
  return {
    _id: sid(n),
    projectId: 'project' as Id<'projects'>,
    candidateName: `Candidate ${n}`,
    candidateEmail: `c${n}@example.test`,
    status: 'completed',
    invitedAt: n,
    startedAt: null,
    completedAt: null,
    lastActivityAt: null,
    durationSeconds: null,
    overallScore: null,
    recommendation: null,
    recruiterDecision: null,
    lastQuestionIndex: 0,
    ...patch,
  }
}

function sortedNames(
  rows: Array<CandidateRow>,
  column: keyof typeof SORT_SPECS,
  desc: boolean,
) {
  let sorting: SortingState = [{ id: column, desc }]
  const table = createTable<CandidateRow>({
    data: rows,
    columns: [{ id: column, ...SORT_SPECS[column] }],
    state: { sorting },
    onStateChange: () => {},
    onSortingChange: (updater) => {
      sorting = typeof updater === 'function' ? updater(sorting) : updater
    },
    renderFallbackValue: null,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })
  return table.getRowModel().rows.map((r) => r.original.candidateName)
}

/** Audit E4: the table could be neither sorted nor filtered. */
describe('sorting the candidate table', () => {
  const rows = [
    row(1, { overallScore: 40, recommendation: 'no' }),
    row(2),
    row(3, { overallScore: 90, recommendation: 'strong_yes' }),
    row(4, { overallScore: 65, recommendation: 'maybe' }),
  ]

  it('ranks by score, with the unscored last in both directions', () => {
    expect(sortedNames(rows, 'score', true)).toEqual([
      'Candidate 3',
      'Candidate 4',
      'Candidate 1',
      'Candidate 2',
    ])
    expect(sortedNames(rows, 'score', false)).toEqual([
      'Candidate 1',
      'Candidate 4',
      'Candidate 3',
      'Candidate 2',
    ])
  })

  it('orders recommendations by strength, not alphabetically', () => {
    expect(sortedNames(rows, 'recommendation', true)).toEqual([
      'Candidate 3',
      'Candidate 4',
      'Candidate 1',
      'Candidate 2',
    ])
  })
})

describe('filtering the candidate table', () => {
  const rows = [
    row(1, { status: 'pending' }),
    row(2, { recruiterDecision: 'shortlisted' }),
    row(3),
  ]
  const keep = (
    status: Parameters<typeof matchesFilters>[1]['status'],
    decision: Parameters<typeof matchesFilters>[1]['decision'],
  ) =>
    rows
      .filter((r) => matchesFilters(r, { status, decision }))
      .map((r) => r._id)

  it('keeps everything by default', () => {
    expect(keep('all', 'all')).toEqual([sid(1), sid(2), sid(3)])
  })

  it('filters by status and by decision, and "none" means undecided', () => {
    expect(keep('pending', 'all')).toEqual([sid(1)])
    expect(keep('all', 'shortlisted')).toEqual([sid(2)])
    expect(keep('completed', 'none')).toEqual([sid(3)])
  })
})

/** Audit C6.3: delivery failures were recorded and never shown. */
describe('delivery issues', () => {
  const event = (
    n: number,
    session: number,
    status: 'sent' | 'delivered' | 'bounced' | 'complained' | 'failed',
    template = 'candidate-invitation',
  ) => ({
    _id: `log_${n}` as Id<'emailLog'>,
    template,
    recipient: `c${session}@example.test`,
    status,
    error: null,
    sessionId: sid(session),
    createdAt: n,
  })

  it('flags an invitation whose latest send bounced or was marked as spam', () => {
    const issues = deliveryIssues([
      event(3, 1, 'bounced'),
      event(2, 2, 'complained'),
      event(1, 3, 'delivered'),
    ])
    expect(Object.fromEntries(issues)).toEqual({
      [sid(1)]: 'bounced',
      [sid(2)]: 'complained',
    })
  })

  it('clears a bounce once a later send was delivered', () => {
    const issues = deliveryIssues([
      event(2, 1, 'delivered'),
      event(1, 1, 'bounced'),
    ])
    expect(issues.size).toBe(0)
  })

  it('ignores mail that is not the invitation', () => {
    const issues = deliveryIssues([event(1, 1, 'bounced', 'report-ready')])
    expect(issues.size).toBe(0)
  })
})
