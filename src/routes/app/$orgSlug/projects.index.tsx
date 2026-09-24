import { useCallback, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Briefcase, Plus } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { ProjectRow } from '~/components/projects/columns'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { EmptyState } from '~/components/projects/EmptyState'
import { ProjectsTable } from '~/components/projects/ProjectsTable'
import { ShareProjectDialog } from '~/components/projects/ShareProjectDialog'

export const Route = createFileRoute('/app/$orgSlug/projects/')({
  component: ProjectsPage,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'projects')('metaTitle'),
      },
    ],
  }),
})

type StatusFilter = 'all' | 'draft' | 'active' | 'archived'

function ProjectsPage() {
  const { t } = useTranslation(['projects', 'common'])
  const { orgSlug } = Route.useParams()
  const locale = getLocale()
  const [filter, setFilter] = useState<StatusFilter>('all')
  const [sharing, setSharing] = useState<ProjectRow | null>(null)

  const me = useConvexQuery(api.users.me)
  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })
  const projects = useConvexQuery(
    api.projects.list,
    org ? { orgId: org._id } : 'skip',
  )
  const archive = useConvexMutation(api.projects.archive)
  const restore = useConvexMutation(api.projects.restore)

  const run = useCallback(
    async (action: Promise<unknown>) => {
      try {
        await action
      } catch (error) {
        const { key, fallbackKey } = errorMessageKey(error, 'projects')
        toast.error(t(key, { defaultValue: t(fallbackKey) }))
      }
    },
    [t],
  )

  const onArchive = useCallback(
    (project: ProjectRow) => void run(archive({ projectId: project._id })),
    [archive, run],
  )
  const onRestore = useCallback(
    (project: ProjectRow) => void run(restore({ projectId: project._id })),
    [restore, run],
  )
  const onShare = useCallback((project: ProjectRow) => setSharing(project), [])

  // Mirrors `requireProjectOwnerOrAdmin`, which is what enforces it: this only
  // spares a member an action the server would refuse.
  const ready = me?.kind === 'ready' ? me : null
  const myRole = ready?.orgs.find((o) => o.slug === orgSlug)?.role
  const managesAll = myRole === 'admin' || myRole === 'owner'
  const visible = (projects ?? [])
    .filter((project) =>
      filter === 'all'
        ? project.status !== 'archived'
        : project.status === filter,
    )
    .map((project) => ({
      ...project,
      canManage: managesAll || project.createdBy === ready?.user._id,
    }))
  const hasAnyProject = (projects ?? []).length > 0

  return (
    <main className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('projects:list.title')}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('projects:list.subtitle')}
          </p>
        </div>
        <Button asChild>
          <Link to="/app/$orgSlug/projects/new" params={{ orgSlug }}>
            <Plus className="size-4" />
            {t('projects:list.new')}
          </Link>
        </Button>
      </div>

      {projects === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-64 w-full rounded-md" />
        </div>
      ) : !hasAnyProject ? (
        <EmptyState
          icon={<Briefcase className="size-8" />}
          title={t('projects:list.empty.title')}
          body={t('projects:list.empty.body')}
          action={
            <Button asChild>
              <Link to="/app/$orgSlug/projects/new" params={{ orgSlug }}>
                {t('projects:list.empty.action')}
              </Link>
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          <Tabs
            value={filter}
            onValueChange={(value) => setFilter(value as StatusFilter)}
          >
            <TabsList>
              {(['all', 'draft', 'active', 'archived'] as const).map((key) => (
                <TabsTrigger key={key} value={key}>
                  {t(`projects:list.filters.${key}`)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <ProjectsTable
            projects={visible}
            orgSlug={orgSlug}
            locale={locale}
            onArchive={onArchive}
            onRestore={onRestore}
            onShare={onShare}
            emptyState={
              <EmptyState
                title={t('projects:list.emptyFiltered.title')}
                body={t('projects:list.emptyFiltered.body')}
              />
            }
          />
        </div>
      )}

      {sharing && org && (
        <ShareProjectDialog
          orgId={org._id}
          projectId={sharing._id}
          open
          onOpenChange={(open) => !open && setSharing(null)}
        />
      )}
    </main>
  )
}
