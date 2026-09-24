import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Mic, Pencil, Send, UserPlus, Users, Video } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { Progress } from '~/components/ui/progress'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs'
import { ProjectStatusBadge } from '~/components/projects/ProjectStatusBadge'
import { ProjectTeamDialog } from '~/components/projects/ProjectTeamDialog'
import { CandidatesTable } from '~/components/candidates/CandidatesTable'
import { InviteCandidatesDialog } from '~/components/candidates/InviteCandidatesDialog'
import { EmptyState } from '~/components/projects/EmptyState'

export const Route = createFileRoute('/app/$orgSlug/projects/$projectSlug/')({
  component: ProjectDetailPage,
  head: () => ({
    meta: [
      { title: getI18n(getLocale()).getFixedT(null, 'projects')('metaTitle') },
    ],
  }),
})

function ProjectDetailPage() {
  const { t } = useTranslation(['projects', 'candidates', 'common'])
  const { orgSlug, projectSlug } = Route.useParams()
  const navigate = useNavigate()
  const [editingTeam, setEditingTeam] = useState(false)
  const [inviting, setInviting] = useState(false)

  const me = useConvexQuery(api.users.me)
  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })
  const data = useConvexQuery(
    api.projects.getBySlug,
    org ? { orgId: org._id, slug: projectSlug } : 'skip',
  )
  const publish = useConvexMutation(api.projects.publish)
  const archive = useConvexMutation(api.projects.archive)
  const restore = useConvexMutation(api.projects.restore)

  const run = async (action: Promise<unknown>) => {
    try {
      await action
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  if (data === undefined) {
    return (
      <main className="flex-1 space-y-6 p-6">
        <Skeleton className="h-9 w-72" />
        <div className="grid gap-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-64 rounded-lg" />
      </main>
    )
  }

  const { project, questions, criteria } = data
  const expired = project.expiresAt !== null && project.expiresAt < Date.now()
  // Mirrors `requireProjectOwnerOrAdmin`, which is what enforces it: this only
  // spares a member an action the server would refuse.
  const ready = me?.kind === 'ready' ? me : null
  const myRole = ready?.orgs.find((o) => o.slug === orgSlug)?.role
  const canManage =
    myRole === 'admin' ||
    myRole === 'owner' ||
    project.createdBy === ready?.user._id

  return (
    <main className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
              {project.title}
            </h1>
            <ProjectStatusBadge status={project.status} expired={expired} />
          </div>
          {project.jobTitle && (
            <p className="text-muted-foreground text-sm">{project.jobTitle}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          {project.status === 'active' && (
            <Button onClick={() => setInviting(true)}>
              <UserPlus className="size-4" />
              {t('projects:detail.invite')}
            </Button>
          )}
          {canManage && (
            <Button variant="outline" onClick={() => setEditingTeam(true)}>
              <Users className="size-4" />
              {t('projects:detail.team')}
            </Button>
          )}
          {project.status !== 'archived' && (
            <Button variant="outline" asChild>
              <Link
                to="/app/$orgSlug/projects/$projectSlug/edit"
                params={{ orgSlug, projectSlug }}
              >
                <Pencil className="size-4" />
                {t('projects:detail.edit')}
              </Link>
            </Button>
          )}
          {project.status === 'draft' && (
            <Button onClick={() => void run(publish({ projectId: project._id }))}>
              <Send className="size-4" />
              {t('projects:detail.publish')}
            </Button>
          )}
          {canManage && project.status === 'active' && (
            <Button
              variant="outline"
              onClick={() => void run(archive({ projectId: project._id }))}
            >
              {t('projects:detail.archive')}
            </Button>
          )}
          {canManage && project.status === 'archived' && (
            <Button
              onClick={async () => {
                await run(restore({ projectId: project._id }))
                await navigate({
                  to: '/app/$orgSlug/projects/$projectSlug',
                  params: { orgSlug, projectSlug },
                })
              }}
            >
              {t('projects:detail.restore')}
            </Button>
          )}
        </div>
      </div>

      {project.status === 'draft' && (
        <Alert>
          <AlertTitle>{t('projects:detail.draftNotice.title')}</AlertTitle>
          <AlertDescription>
            {t('projects:detail.draftNotice.body')}
          </AlertDescription>
        </Alert>
      )}
      {project.status === 'archived' && (
        <Alert>
          <AlertTitle>{t('projects:detail.archivedNotice.title')}</AlertTitle>
          <AlertDescription>
            {t('projects:detail.archivedNotice.body')}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t('projects:detail.stats.questions')}
          value={String(questions.length)}
        />
        <StatCard
          label={t('projects:detail.stats.criteria')}
          value={String(criteria.length)}
        />
        <StatCard
          label={t('projects:detail.stats.duration')}
          value={t('projects:detail.stats.durationValue', {
            count: project.maxDurationMinutes,
          })}
        />
        <StatCard
          label={t('projects:detail.stats.expiry')}
          value={
            project.expiresAt
              ? new Date(project.expiresAt).toLocaleDateString(getLocale())
              : t('projects:detail.stats.noExpiry')
          }
        />
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">
            {t('projects:detail.overview')}
          </TabsTrigger>
          <TabsTrigger value="candidates">
            {t('projects:detail.candidates')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-6">
      <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('projects:detail.questions')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {questions.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('projects:questions.empty.body')}
                  </p>
                ) : (
                  <ol className="space-y-3">
                    {questions.map((question, index) => (
                      <li key={question._id} className="flex gap-3">
                        <span className="text-muted-foreground w-5 shrink-0 text-sm tabular-nums">
                          {index + 1}.
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm">{question.content}</p>
                          <p className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                            {question.hasMedia ? (
                              <>
                                {question.mediaKind === 'audio' ? (
                                  <Mic className="size-3" />
                                ) : (
                                  <Video className="size-3" />
                                )}
                                {t('projects:questions.media.ready')}
                              </>
                            ) : (
                              t('projects:questions.media.none')
                            )}
                            <span aria-hidden>·</span>
                            <span className="tabular-nums">
                              {t('projects:questions.fields.maxResponseValue', {
                                count: question.maxResponseSeconds,
                              })}
                            </span>
                          </p>
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('projects:detail.criteria')}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {criteria.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('projects:criteria.empty.body')}
                  </p>
                ) : (
                  criteria.map((criterion) => (
                    <div key={criterion._id} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-3">
                        <span className="truncate text-sm font-medium">
                          {criterion.label}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                          {t('projects:criteria.normalized', {
                            percent: criterion.normalizedWeight,
                          })}
                        </span>
                      </div>
                      <Progress value={criterion.normalizedWeight} />
                      {criterion.description && (
                        <p className="text-muted-foreground text-xs">
                          {criterion.description}
                        </p>
                      )}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="candidates" className="pt-6">
          {project.status === 'draft' ? (
            <EmptyState
              title={t('candidates:list.emptyDraft.title')}
              body={t('candidates:list.emptyDraft.body')}
            />
          ) : (
            org && (
              <CandidatesTable
                orgId={org._id}
                projectId={project._id}
                orgSlug={orgSlug}
                canInvite={project.status === 'active'}
                canManage={canManage}
                onInvite={() => setInviting(true)}
                locale={getLocale()}
              />
            )
          )}
        </TabsContent>
      </Tabs>

      <InviteCandidatesDialog
        projectId={project._id}
        open={inviting}
        onOpenChange={setInviting}
      />

      {org && (
        <ProjectTeamDialog
          orgId={org._id}
          projectId={project._id}
          open={editingTeam}
          onOpenChange={setEditingTeam}
        />
      )}
    </main>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {label}
        </p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      </CardContent>
    </Card>
  )
}
