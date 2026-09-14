import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useConvexMutation, useConvexPaginatedQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { MoreHorizontal, UserPlus } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import { DecisionBadge, SessionStatusBadge } from './StatusBadge'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
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

type Row = {
  _id: Id<'sessions'>
  candidateName: string
  candidateEmail: string
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled' | 'expired'
  invitedAt: number
  completedAt: number | null
  durationSeconds: number | null
  recruiterDecision: 'rejected' | 'maybe' | 'shortlisted' | 'hired' | null
}

export function CandidatesTable({
  projectId,
  orgSlug,
  canInvite,
  onInvite,
  locale,
}: {
  projectId: Id<'projects'>
  orgSlug: string
  canInvite: boolean
  onInvite: () => void
  locale: string
}) {
  const { t } = useTranslation(['candidates', 'common'])
  const { results, status, loadMore } = useConvexPaginatedQuery(
    api.sessions.listByProject,
    { projectId },
    { initialNumItems: 25 },
  )
  const resend = useConvexMutation(api.sessions.resendInvitation)
  const cancel = useConvexMutation(api.sessions.cancel)
  const [pendingCancel, setPendingCancel] = useState<Row | null>(null)

  const notify = (error: unknown) => {
    const { key, fallbackKey } = errorMessageKey(error, 'candidates')
    toast.error(t(key, { defaultValue: t(fallbackKey) }))
  }

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

  return (
    <div className="space-y-3">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('candidates:list.columns.candidate')}</TableHead>
              <TableHead>{t('candidates:list.columns.status')}</TableHead>
              <TableHead>{t('candidates:list.columns.decision')}</TableHead>
              <TableHead className="text-right">
                {t('candidates:list.columns.invited')}
              </TableHead>
              <TableHead className="text-right">
                {t('candidates:list.columns.duration')}
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(results as Array<Row>).map((row) => (
              <TableRow key={row._id}>
                <TableCell>
                  <Link
                    to="/app/$orgSlug/candidates/$sessionId"
                    params={{ orgSlug, sessionId: row._id }}
                    className="hover:text-primary block font-medium underline-offset-4 hover:underline"
                  >
                    {row.candidateName}
                  </Link>
                  <span className="text-muted-foreground text-xs">
                    {row.candidateEmail}
                  </span>
                </TableCell>
                <TableCell>
                  <SessionStatusBadge status={row.status} />
                </TableCell>
                <TableCell>
                  <DecisionBadge decision={row.recruiterDecision} />
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {new Date(row.invitedAt).toLocaleDateString(locale)}
                </TableCell>
                <TableCell className="text-muted-foreground text-right tabular-nums">
                  {row.durationSeconds
                    ? `${Math.round(row.durationSeconds / 60)} min`
                    : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8">
                        <MoreHorizontal className="size-4" />
                        <span className="sr-only">
                          {t('common:actions.edit')}
                        </span>
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem asChild>
                        <Link
                          to="/app/$orgSlug/candidates/$sessionId"
                          params={{ orgSlug, sessionId: row._id }}
                        >
                          {t('candidates:actions.open')}
                        </Link>
                      </DropdownMenuItem>
                      {row.status !== 'completed' &&
                        row.status !== 'cancelled' && (
                          <>
                            <DropdownMenuItem
                              onSelect={() => {
                                void resend({ sessionId: row._id })
                                  .then(() =>
                                    toast.success(
                                      t('candidates:actions.resent'),
                                    ),
                                  )
                                  .catch(notify)
                              }}
                            >
                              {t('candidates:actions.resend')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onSelect={() => setPendingCancel(row)}
                            >
                              {t('candidates:actions.cancel')}
                            </DropdownMenuItem>
                          </>
                        )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {status === 'CanLoadMore' && (
        <Button variant="outline" onClick={() => loadMore(25)}>
          {t('candidates:list.loadMore')}
        </Button>
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
                    .then(() => toast.success(t('candidates:actions.cancelled')))
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
