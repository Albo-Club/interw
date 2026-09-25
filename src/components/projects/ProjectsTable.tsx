import { useMemo, useState } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { buildProjectColumns } from './columns'
import type { SortingState } from '@tanstack/react-table'

import type { ProjectRow } from './columns'
import { Input } from '~/components/ui/input'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table'
import { DataTablePagination } from '~/components/data-table/DataTablePagination'

export function ProjectsTable({
  projects,
  orgSlug,
  locale,
  onArchive,
  onRestore,
  onEditTeam,
  emptyState,
}: {
  projects: Array<ProjectRow>
  orgSlug: string
  locale: string
  onArchive: (project: ProjectRow) => void
  onRestore: (project: ProjectRow) => void
  onEditTeam: (project: ProjectRow) => void
  emptyState: React.ReactNode
}) {
  const { t } = useTranslation(['projects', 'common'])
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'createdAt', desc: true },
  ])
  const [globalFilter, setGlobalFilter] = useState('')

  const columns = useMemo(
    () =>
      buildProjectColumns({ orgSlug, locale, onArchive, onRestore, onEditTeam, t }),
    [orgSlug, locale, onArchive, onRestore, onEditTeam, t],
  )

  const table = useReactTable({
    data: projects,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 20 } },
  })

  return (
    <div className="space-y-3">
      <div className="relative max-w-sm">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
        <Input
          value={globalFilter}
          onChange={(event) => setGlobalFilter(event.target.value)}
          placeholder={t('projects:list.search')}
          aria-label={t('projects:list.search')}
          className="pl-9"
        />
      </div>

      {table.getRowModel().rows.length === 0 ? (
        emptyState
      ) : (
        <>
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
          <DataTablePagination table={table} />
        </>
      )}
    </div>
  )
}
