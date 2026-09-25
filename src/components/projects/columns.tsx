import { Link } from '@tanstack/react-router'
import { MoreHorizontal } from 'lucide-react'
import { ProjectStatusBadge } from './ProjectStatusBadge'
import type { ColumnDef } from '@tanstack/react-table'
import type { TFunction } from 'i18next'

import type { Id } from '../../../convex/_generated/dataModel'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu'
import { DataTableColumnHeader } from '~/components/data-table/DataTableColumnHeader'

export type ProjectRow = {
  _id: Id<'projects'>
  slug: string
  title: string
  jobTitle: string | null
  status: 'draft' | 'active' | 'archived'
  language: 'fr' | 'en'
  createdAt: number
  expiresAt: number | null
  sessionCount: number
  completedSessionCount: number
  /** Badge the row: the caller is on the role's team, so is emailed about
   *  its reports. Only owners and admins see roles they are not on, so the
   *  page sets it for them alone — for a member it would mark every row. */
  onTeam: boolean
  /** Team, archive, restore: org owners and admins, and the role's creator. */
  canManage: boolean
}

function formatDate(timestamp: number, locale: string) {
  return new Date(timestamp).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })
}

export function buildProjectColumns({
  orgSlug,
  locale,
  onArchive,
  onRestore,
  onEditTeam,
  t,
}: {
  orgSlug: string
  locale: string
  onArchive: (project: ProjectRow) => void
  onRestore: (project: ProjectRow) => void
  onEditTeam: (project: ProjectRow) => void
  t: TFunction<['projects', 'common']>
}): Array<ColumnDef<ProjectRow>> {
  return [
    {
      accessorKey: 'title',
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('projects:list.columns.title')}
        />
      ),
      cell: ({ row }) => (
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Link
              to="/app/$orgSlug/projects/$projectSlug"
              params={{ orgSlug, projectSlug: row.original.slug }}
              className="hover:text-primary truncate font-medium underline-offset-4 hover:underline"
            >
              {row.original.title}
            </Link>
            {row.original.onTeam && (
              <Badge variant="secondary" className="shrink-0">
                {t('projects:list.onTeam')}
              </Badge>
            )}
          </div>
          {row.original.jobTitle && (
            <p className="text-muted-foreground truncate text-xs">
              {row.original.jobTitle}
            </p>
          )}
        </div>
      ),
    },
    {
      accessorKey: 'status',
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('projects:list.columns.status')}
        />
      ),
      cell: ({ row }) => (
        <ProjectStatusBadge
          status={row.original.status}
          expired={
            row.original.expiresAt !== null &&
            row.original.expiresAt < Date.now()
          }
        />
      ),
    },
    {
      accessorKey: 'sessionCount',
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('projects:list.columns.candidates')}
        />
      ),
      // Right-aligned tabular figures: these columns exist to be compared.
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {row.original.sessionCount}
        </span>
      ),
    },
    {
      accessorKey: 'completedSessionCount',
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('projects:list.columns.completed')}
        />
      ),
      cell: ({ row }) => (
        <span className="block text-right tabular-nums">
          {row.original.completedSessionCount}
        </span>
      ),
    },
    {
      accessorKey: 'createdAt',
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t('projects:list.columns.created')}
        />
      ),
      cell: ({ row }) => (
        <span className="text-muted-foreground tabular-nums">
          {formatDate(row.original.createdAt, locale)}
        </span>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <div className="flex justify-end">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8">
                <MoreHorizontal className="size-4" />
                <span className="sr-only">
                  {t('projects:list.columns.actions')}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link
                  to="/app/$orgSlug/projects/$projectSlug/edit"
                  params={{ orgSlug, projectSlug: row.original.slug }}
                >
                  {t('projects:detail.edit')}
                </Link>
              </DropdownMenuItem>
              {row.original.canManage && (
                <>
                  <DropdownMenuItem onSelect={() => onEditTeam(row.original)}>
                    {t('projects:detail.team')}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {row.original.status === 'archived' ? (
                    <DropdownMenuItem onSelect={() => onRestore(row.original)}>
                      {t('projects:detail.restore')}
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onSelect={() => onArchive(row.original)}>
                      {t('projects:detail.archive')}
                    </DropdownMenuItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ]
}
