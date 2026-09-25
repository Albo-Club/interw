import { useEffect } from 'react'
import {
  Link,
  createFileRoute,
  useNavigate,
} from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConvexError } from 'convex/values'
import { usePaginatedQuery } from 'convex/react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

const PAGE_SIZE = 25

export const Route = createFileRoute('/app/admin')({
  component: AdminPage,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'nav')('admin.metaTitle'),
      },
    ],
  }),
})

function AdminPage() {
  const navigate = useNavigate()
  const { t, i18n } = useTranslation('nav')
  const me = useConvexQuery(api.users.me)
  const allowed = me?.kind === 'ready' && me.user.superAdmin
  const overview = useConvexQuery(api.admin.overview, allowed ? {} : 'skip')
  // Paginated (Back F8): both lists used to read their whole table.
  const orgs = usePaginatedQuery(api.admin.listOrgs, allowed ? {} : 'skip', {
    initialNumItems: PAGE_SIZE,
  })
  const users = usePaginatedQuery(api.admin.listUsers, allowed ? {} : 'skip', {
    initialNumItems: PAGE_SIZE,
  })
  const setSuperAdmin = useConvexMutation(api.admin.setSuperAdmin)
  const health = useConvexQuery(
    api.admin.pipelineHealth,
    allowed ? {} : 'skip',
  )
  const relaunch = useConvexMutation(api.admin.relaunchSession)

  useEffect(() => {
    if (me?.kind === 'ready' && !me.user.superAdmin) {
      navigate({ to: '/app' })
    }
  }, [me, navigate])

  if (!me || me.kind !== 'ready') {
    return (
      <main className="mx-auto max-w-5xl p-6">
        <ListSkeleton />
      </main>
    )
  }

  if (!me.user.superAdmin) {
    return (
      <main className="flex min-h-svh items-center justify-center">
        <p className="text-muted-foreground text-sm">{t('redirecting')}</p>
      </main>
    )
  }

  async function handleToggle(userId: Id<'users'>, value: boolean) {
    try {
      await setSuperAdmin({ userId, value })
      toast.success(value ? t('admin.granted') : t('admin.revoked'))
    } catch (err) {
      const code = err instanceof ConvexError ? (err.data as string) : ''
      toast.error(
        code === 'last_super_admin'
          ? t('admin.lastSuperAdmin')
          : t('admin.actionFailed'),
      )
    }
  }

  async function handleRelaunch(sessionId: Id<'sessions'>) {
    try {
      await relaunch({ sessionId })
      toast.success(t('admin.pipeline.stuck.relaunched'))
    } catch {
      toast.error(t('admin.pipeline.stuck.failed'))
    }
  }

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('admin.title')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('admin.subtitle')}</p>
        </div>
        <Button asChild variant="outline">
          <Link to="/app">{t('admin.back')}</Link>
        </Button>
      </header>

      <div className="grid gap-4 sm:grid-cols-4">
        <Stat label={t('admin.stats.users')} value={overview?.users} />
        <Stat
          label={t('admin.stats.organizations')}
          value={overview?.orgs}
        />
        <Stat
          label={t('admin.stats.memberships')}
          value={overview?.members}
        />
        <Stat
          label={t('admin.stats.pendingInvites')}
          value={overview?.pendingInvitations}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('admin.pipeline.title')}</CardTitle>
          <CardDescription>{t('admin.pipeline.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {!health ? (
            <ListSkeleton />
          ) : (
            health.windows.map((window) => (
              <section key={window.days} className="space-y-2">
                <h3 className="text-sm font-medium">
                  {t('admin.pipeline.window', { count: window.days })}
                </h3>
                <div className="grid gap-2 sm:grid-cols-3">
                  {window.counts.map((row) => (
                    <div key={row.step} className="rounded-md border p-3">
                      <p className="text-xs font-medium">
                        {t(`admin.pipeline.step.${row.step}`)}
                      </p>
                      <dl className="mt-2 space-y-1">
                        {(['succeeded', 'failed', 'skipped'] as const).map(
                          (outcome) => (
                            <div
                              key={outcome}
                              className="flex items-baseline justify-between gap-2"
                            >
                              <dt className="text-muted-foreground text-xs">
                                {t(`admin.pipeline.outcome.${outcome}`)}
                              </dt>
                              <dd
                                className={
                                  'text-sm tabular-nums ' +
                                  (outcome === 'failed' &&
                                  row.outcomes[outcome].count > 0
                                    ? 'text-destructive font-semibold'
                                    : '')
                                }
                              >
                                {row.outcomes[outcome].count}
                                {row.outcomes[outcome].capped ? '+' : ''}
                              </dd>
                            </div>
                          ),
                        )}
                      </dl>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('admin.pipeline.stuck.title')}</CardTitle>
          <CardDescription>
            {t('admin.pipeline.stuck.description')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!health ? (
            <ListSkeleton />
          ) : health.stuck.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('admin.pipeline.stuck.empty')}
            </p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {health.stuck.map((row) => (
                <li
                  key={row.sessionId}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{row.candidateName}</p>
                    <p className="text-muted-foreground truncate text-xs tabular-nums">
                      {t('admin.pipeline.stuck.progress', {
                        settled: row.settled,
                        expected: row.expected,
                      })}
                      {row.completedAt
                        ? ` · ${new Date(row.completedAt).toLocaleDateString(i18n.language)}`
                        : ''}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRelaunch(row.sessionId)}
                  >
                    {t('admin.pipeline.stuck.relaunch')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('admin.orgs.title')}</CardTitle>
          <CardDescription>{t('admin.orgs.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {orgs.status === 'LoadingFirstPage' ? (
            <ListSkeleton />
          ) : orgs.results.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('admin.orgs.empty')}
            </p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {orgs.results.map((o) => (
                <li
                  key={o._id}
                  className="flex items-center justify-between py-3"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{o.name}</p>
                    <p className="text-muted-foreground truncate text-xs">
                      /{o.slug} ·{' '}
                      {t('admin.orgs.members', { count: o.memberCount })}
                    </p>
                  </div>
                  <span className="text-muted-foreground text-xs">
                    {new Date(o.createdAt).toLocaleDateString(i18n.language)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <LoadMore
            status={orgs.status}
            onLoad={() => orgs.loadMore(PAGE_SIZE)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('admin.users.title')}</CardTitle>
          <CardDescription>{t('admin.users.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          {users.status === 'LoadingFirstPage' ? (
            <ListSkeleton />
          ) : users.results.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {t('admin.users.empty')}
            </p>
          ) : (
            <ul className="divide-border divide-y text-sm">
              {users.results.map((u) => {
                const isSelf = u._id === me.user._id
                return (
                  <li
                    key={u._id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-medium">
                        {u.name ?? u.email}
                        {isSelf && (
                          <span className="text-muted-foreground ml-2 text-xs">
                            {t('admin.users.you')}
                          </span>
                        )}
                      </p>
                      <p className="text-muted-foreground truncate text-xs">
                        {u.email} ·{' '}
                        {t('admin.users.orgs', { count: u.orgCount })}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={u.superAdmin ? 'default' : 'outline'}
                      onClick={() => handleToggle(u._id, !u.superAdmin)}
                    >
                      {u.superAdmin
                        ? t('admin.users.isSuperAdmin')
                        : t('admin.users.makeSuperAdmin')}
                    </Button>
                  </li>
                )
              })}
            </ul>
          )}
          <LoadMore
            status={users.status}
            onLoad={() => users.loadMore(PAGE_SIZE)}
          />
        </CardContent>
      </Card>
    </main>
  )
}

function Stat({
  label,
  value,
}: {
  label: string
  value: { count: number; capped: boolean } | undefined
}) {
  const { t } = useTranslation('nav')
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-muted-foreground text-xs">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">
          {!value
            ? '—'
            : value.capped
              ? t('admin.stats.atLeast', { value: value.count })
              : value.count}
        </p>
      </CardContent>
    </Card>
  )
}

/** Rows in the shape of the lists below, while their first page loads. */
function ListSkeleton() {
  const { t } = useTranslation('nav')
  return (
    <div role="status" aria-label={t('loading')} className="space-y-2">
      {Array.from({ length: 3 }, (_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  )
}

function LoadMore({ status, onLoad }: { status: string; onLoad: () => void }) {
  const { t } = useTranslation('nav')
  if (status !== 'CanLoadMore') return null
  return (
    <Button variant="outline" size="sm" className="mt-3" onClick={onLoad}>
      {t('admin.loadMore')}
    </Button>
  )
}
