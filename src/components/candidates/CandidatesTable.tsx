import { useCallback, useMemo, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { useConvex } from 'convex/react'
import {
  useConvexMutation,
  useConvexPaginatedQuery,
  useConvexQuery,
} from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { UserPlus } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import { buildCandidateColumns } from './columns'
import { deliveryIssues, matchesFilters } from './candidate-rows'
import type { SortingState } from '@tanstack/react-table'
import type {
  CandidateRow,
  DecisionFilter,
  StatusFilter,
} from './candidate-rows'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { EmptyState } from '~/components/projects/EmptyState'
import { AiDisclaimer } from '~/components/report/AiDisclaimer'

const PAGE_SIZE = 25
const STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'expired',
  'cancelled',
] as const
const DECISIONS = ['none', 'shortlisted', 'maybe', 'hired', 'rejected'] as const

export function CandidatesTable({
  orgId,
  projectId,
  orgSlug,
  canInvite,
  canManage,
  onInvite,
  locale,
}: {
  orgId: Id<'organizations'>
  projectId: Id<'projects'>
  orgSlug: string
  canInvite: boolean
  canManage: boolean
  onInvite: () => void
  locale: string
}) {
  const { t } = useTranslation(['candidates', 'common'])
  const convex = useConvex()
  const { results, status, loadMore } = useConvexPaginatedQuery(
    api.sessions.listByProject,
    { projectId },
    { initialNumItems: PAGE_SIZE },
  )
  // The org's latest 200 sends, already narrowed server-side to the roles
  // this caller can see. A bounce older than that window is not flagged.
  const events = useConvexQuery(api.emailEvents.recent, { orgId, limit: 200 })
  const resend = useConvexMutation(api.sessions.resendInvitation)
  const cancel = useConvexMutation(api.sessions.cancel)
  const [pendingCancel, setPendingCancel] = useState<CandidateRow | null>(null)
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'invitedAt', desc: true },
  ])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all')

  const notify = useCallback(
    (error: unknown) => {
      const { key, fallbackKey } = errorMessageKey(error, 'candidates')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    },
    [t],
  )

  const columns = useMemo(() => {
    const copyLink = (row: CandidateRow) => {
      let refusal: unknown = null
      const url = convex
        .query(api.sessions.invitationLink, { sessionId: row._id })
        .then(
          (link) => link.url,
          (error: unknown) => {
            refusal = error
            throw error
          },
        )
      // Safari drops the click's permission to write the clipboard across an
      // await. Handing it a pending blob keeps the write inside the gesture.
      const written =
        typeof ClipboardItem === 'undefined'
          ? url.then((text) => navigator.clipboard.writeText(text))
          : navigator.clipboard.write([
              new ClipboardItem({
                'text/plain': url.then(
                  (text) => new Blob([text], { type: 'text/plain' }),
                ),
              }),
            ])
      written
        .then(() => toast.success(t('candidates:actions.linkCopied')))
        // The clipboard rewraps a failed blob in its own error, so the
        // server's refusal is kept aside to be reported as itself.
        .catch(() =>
          refusal
            ? notify(refusal)
            : toast.error(t('candidates:actions.copyFailed')),
        )
    }
    return buildCandidateColumns({
      orgSlug,
      locale,
      canManage,
      deliveryIssues: deliveryIssues(events ?? []),
      onCopyLink: copyLink,
      onResend: (row) => {
        resend({ sessionId: row._id })
          .then(() => toast.success(t('candidates:actions.resent')))
          .catch(notify)
      },
      onCancel: setPendingCancel,
      t,
    })
  }, [orgSlug, locale, canManage, events, convex, resend, notify, t])

  const rows = useMemo(
    () =>
      results.filter((row) =>
        matchesFilters(row, { status: statusFilter, decision: decisionFilter }),
      ),
    [results, statusFilter, decisionFilter],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row._id,
  })

  if (status === 'LoadingFirstPage') {
    return <Skeleton className="h-64 w-full rounded-md" />
  }

  if (results.length === 0) {
    return (
      <EmptyState
        icon={<UserPlus className="size-8" />}
        title={t('candidates:list.empty.title')}
        body={t('candidates:list.empty.body')}
        action={
          canInvite ? (
            <Button onClick={onInvite}>
              {t('candidates:list.empty.action')}
            </Button>
          ) : undefined
        }
      />
    )
  }

  const filtered = statusFilter !== 'all' || decisionFilter !== 'all'
  const clearFilters = () => {
    setStatusFilter('all')
    setDecisionFilter('all')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Select
          value={statusFilter}
          onValueChange={(value) => setStatusFilter(value as StatusFilter)}
        >
          <SelectTrigger
            className="w-44"
            aria-label={t('candidates:list.filters.status')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t('candidates:list.filters.allStatuses')}
            </SelectItem>
            {STATUSES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`candidates:status.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={decisionFilter}
          onValueChange={(value) => setDecisionFilter(value as DecisionFilter)}
        >
          <SelectTrigger
            className="w-44"
            aria-label={t('candidates:list.filters.decision')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t('candidates:list.filters.allDecisions')}
            </SelectItem>
            {DECISIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`candidates:decision.${value}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {filtered && (
          <Button variant="ghost" onClick={clearFilters}>
            {t('candidates:list.filters.clear')}
          </Button>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="text-muted-foreground rounded-md border p-6 text-center text-sm">
          {t('candidates:list.filters.noMatch')}
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder
                        ? null
                        : flexRender(
                            header.column.columnDef.header,
                            header.getContext(),
                          )}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(
                        cell.column.columnDef.cell,
                        cell.getContext(),
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <AiDisclaimer />

      {status === 'CanLoadMore' && (
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="outline" onClick={() => loadMore(PAGE_SIZE)}>
            {t('candidates:list.loadMore')}
          </Button>
          {/* Pagination is server-side: sorting a partial list must say so,
              or the top of the column reads as the best of the role. */}
          <p className="text-muted-foreground text-sm" aria-live="polite">
            {t('candidates:list.partial', { count: results.length })}
          </p>
        </div>
      )}

      <AlertDialog
        open={pendingCancel !== null}
        onOpenChange={(open) => !open && setPendingCancel(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('candidates:cancelConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('candidates:cancelConfirm.body', {
                name: pendingCancel?.candidateName ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingCancel) {
                  void cancel({ sessionId: pendingCancel._id })
                    .then(() =>
                      toast.success(t('candidates:actions.cancelled')),
                    )
                    .catch(notify)
                }
                setPendingCancel(null)
              }}
            >
              {t('candidates:cancelConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
