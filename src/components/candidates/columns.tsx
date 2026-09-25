import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import {
  DecisionBadge,
  DeliveryIssueBadge,
  RecommendationLabel,
  ScoreBadge,
  SessionStatusBadge,
} from './StatusBadge'
import { SORT_SPECS } from './candidate-rows'
import type { CandidateRow } from './candidate-rows'
import type { ColumnDef } from '@tanstack/react-table'
import type { TFunction } from 'i18next'

import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { DataTableColumnHeader } from '~/components/data-table/DataTableColumnHeader'

export function buildCandidateColumns({
  orgSlug,
  locale,
  canManage,
  canInvite,
  onCopyLink,
  onResend,
  onCancel,
  t,
}: {
  orgSlug: string
  locale: string
  /** Owner, admin or the role's creator: what `invitationLink` requires. */
  canManage: boolean
  /** Active and before its deadline: what `resendInvitation` requires. */
  canInvite: boolean
  onCopyLink: (row: CandidateRow) => void
  onResend: (row: CandidateRow) => void
  onCancel: (row: CandidateRow) => void
  t: TFunction<['candidates', 'common']>
}): Array<ColumnDef<CandidateRow>> {
  return [
    {
      id: 'candidate',
      ...SORT_SPECS.candidate,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('candidates:list.columns.candidate')}
        />
      ),
      cell: ({ row }) => {
        const issue = row.original.deliveryIssue
        return (
          <div className="min-w-0">
            <Link
              to="/app/$orgSlug/candidates/$sessionId"
              params={{ orgSlug, sessionId: row.original._id }}
              className="hover:text-primary block truncate font-medium underline-offset-4 hover:underline"
            >
              {row.original.candidateName}
            </Link>
            <span className="text-muted-foreground block truncate text-xs">
              {row.original.candidateEmail}
            </span>
            {issue && <DeliveryIssueBadge issue={issue} />}
          </div>
        )
      },
    },
    {
      id: 'status',
      enableSorting: false,
      header: () => t('candidates:list.columns.status'),
      cell: ({ row }) => <SessionStatusBadge status={row.original.status} />,
    },
    {
      id: 'score',
      ...SORT_SPECS.score,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('candidates:list.columns.score')}
          className="justify-end"
        />
      ),
      // Right-aligned tabular figures: this column exists to be compared.
      cell: ({ row }) => (
        <span className="block text-right">
          {row.original.overallScore === null ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            <ScoreBadge score={row.original.overallScore} />
          )}
        </span>
      ),
    },
    {
      id: 'recommendation',
      ...SORT_SPECS.recommendation,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('candidates:list.columns.recommendation')}
        />
      ),
      cell: ({ row }) => (
        <RecommendationLabel recommendation={row.original.recommendation} />
      ),
    },
    {
      id: 'decision',
      enableSorting: false,
      header: () => t('candidates:list.columns.decision'),
      cell: ({ row }) => (
        <DecisionBadge decision={row.original.recruiterDecision} />
      ),
    },
    {
      id: 'invitedAt',
      ...SORT_SPECS.invitedAt,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('candidates:list.columns.invited')}
          className="justify-end"
        />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground block text-right tabular-nums">
          {new Date(row.original.invitedAt).toLocaleDateString(locale)}
        </span>
      ),
    },
    {
      id: 'duration',
      ...SORT_SPECS.duration,
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('candidates:list.columns.duration')}
          className="justify-end"
        />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground block text-right tabular-nums">
          {row.original.durationSeconds
            ? `${Math.round(row.original.durationSeconds / 60)} min`
            : '—'}
        </span>
      ),
    },
    {
      id: 'actions',
      enableSorting: false,
      cell: ({ row }) => {
        // An expired link is closed like the other two: resending it would
        // mail the candidate a page that says it has expired.
        const open =
          row.original.status === 'pending' ||
          row.original.status === 'in_progress'
        return (
          <div className="flex justify-end">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8">
                  <MoreHorizontal className="size-4" />
                  <span className="sr-only">
                    {t('candidates:list.columns.actions')}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem asChild>
                  <Link
                    to="/app/$orgSlug/candidates/$sessionId"
                    params={{ orgSlug, sessionId: row.original._id }}
                  >
                    {t('candidates:actions.open')}
                  </Link>
                </DropdownMenuItem>
                {open && canInvite && (
                  <DropdownMenuItem onSelect={() => onResend(row.original)}>
                    {t('candidates:actions.resend')}
                  </DropdownMenuItem>
                )}
                {/* Both go through `requireProjectOwnerOrAdmin`; showing
                    them to anyone else only offers a refusal. */}
                {open && canManage && (
                  <>
                    <DropdownMenuItem onSelect={() => onCopyLink(row.original)}>
                      {t('candidates:actions.copyLink')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => onCancel(row.original)}>
                      {t('candidates:actions.cancel')}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )
      },
    },
  ]
}
