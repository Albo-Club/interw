import { useTranslation } from 'react-i18next'

import { Skeleton } from '~/components/ui/skeleton'

/**
 * Placeholder in the shape of the recruiter shell — sidebar, header, a row
 * of figures and a table — shown while the session and the organisation
 * resolve. A cold load lands here first, so the layout does not jump when
 * the real shell arrives.
 */
export function AppShellSkeleton() {
  const { t } = useTranslation('nav')
  return (
    <div
      role="status"
      aria-label={t('loading')}
      className="flex h-svh overflow-hidden"
    >
      <div className="bg-sidebar hidden w-64 shrink-0 flex-col gap-3 border-r p-3 md:flex">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="mt-4 h-7 w-3/4" />
        <Skeleton className="h-7 w-2/3" />
        <Skeleton className="h-7 w-3/4" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-16 shrink-0 items-center gap-3 px-4">
          <Skeleton className="size-7" />
          <Skeleton className="h-4 w-40" />
        </div>
        <div className="space-y-6 p-6">
          <Skeleton className="h-8 w-56" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <Skeleton key={i} className="h-28 rounded-lg" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-lg" />
        </div>
      </div>
    </div>
  )
}
