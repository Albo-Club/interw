import { useEffect, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useConvexQuery } from '@convex-dev/react-query'
import { Briefcase, ClipboardCheck, Send, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'

import { api } from '../../../../convex/_generated/api'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { KpiCard } from '~/components/dashboard/KpiCard'
import {
  DecisionBadge,
  ScoreBadge,
} from '~/components/candidates/StatusBadge'

export const Route = createFileRoute('/app/$orgSlug/')({
  component: OrgDashboard,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'dashboard')('metaTitle'),
      },
    ],
  }),
})

function OrgDashboard() {
  const { t } = useTranslation(['dashboard', 'candidates', 'common'])
  const { orgSlug } = Route.useParams()
  const locale = getLocale()
  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })

  // The window boundary is passed in rather than read inside the query: a
  // Convex query is not re-run as time passes, so a clock read there would
  // pin "the last 30 days" to whenever the page first loaded.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5 * 60_000)
    return () => clearInterval(timer)
  }, [])

  const data = useConvexQuery(
    api.dashboard.overview,
    org ? { orgId: org._id, now } : 'skip',
  )

  const completionRate =
    data && data.invitedInWindow > 0
      ? Math.round((data.completedInWindow / data.invitedInWindow) * 100)
      : 0
  const totalDecisions = data
    ? Object.values(data.decisions).reduce((sum, value) => sum + value, 0)
    : 0

  return (
    <main className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {org?.name ?? orgSlug}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('dashboard:interw.subtitle')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <Link to="/app/$orgSlug/projects" params={{ orgSlug }}>
              {t('dashboard:interw.viewAll')}
            </Link>
          </Button>
          <Button asChild>
            <Link to="/app/$orgSlug/projects/new" params={{ orgSlug }}>
              {t('dashboard:interw.newRole')}
            </Link>
          </Button>
        </div>
      </div>

      {data === undefined ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((index) => (
            <Skeleton key={index} className="h-28 rounded-lg" />
          ))}
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {/* First card on purpose: this is the number that decides whether
                a recruiter needs to open the app today. */}
            <KpiCard
              label={t('dashboard:interw.awaitingReview')}
              value={String(data.awaitingReview)}
              icon={ClipboardCheck}
              hint={t('dashboard:interw.awaitingReviewHint')}
            />
            <KpiCard
              label={t('dashboard:interw.activeRoles')}
              value={String(data.activeRoles)}
              icon={Briefcase}
              hint={t('dashboard:interw.draftRoles', {
                count: data.draftRoles,
              })}
            />
            <KpiCard
              label={t('dashboard:interw.invited')}
              value={String(data.invitedInWindow)}
              icon={Send}
              hint={t('dashboard:interw.invitedHint', {
                count: data.windowDays,
              })}
            />
            <KpiCard
              label={t('dashboard:interw.completed')}
              value={String(data.completedInWindow)}
              icon={Users}
              hint={t('dashboard:interw.completionRate', {
                percent: completionRate,
              })}
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('dashboard:interw.recent')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.recent.length === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('dashboard:interw.recentEmpty')}
                  </p>
                ) : (
                  <ul className="divide-border divide-y">
                    {data.recent.map((entry) => (
                      <li
                        key={entry.sessionId}
                        className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                      >
                        <div className="min-w-0">
                          <Link
                            to="/app/$orgSlug/candidates/$sessionId"
                            params={{
                              orgSlug,
                              sessionId: entry.sessionId,
                            }}
                            className="hover:text-primary block truncate font-medium underline-offset-4 hover:underline"
                          >
                            {entry.candidateName}
                          </Link>
                          <span className="text-muted-foreground truncate text-xs">
                            {entry.projectTitle} ·{' '}
                            {new Date(entry.completedAt).toLocaleDateString(
                              locale,
                            )}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          {entry.score !== null && (
                            <ScoreBadge score={entry.score} />
                          )}
                          <DecisionBadge
                            decision={
                              entry.decision as
                                | 'rejected'
                                | 'maybe'
                                | 'shortlisted'
                                | 'hired'
                                | null
                            }
                          />
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('dashboard:interw.decisions')}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {totalDecisions === 0 ? (
                  <p className="text-muted-foreground text-sm">
                    {t('dashboard:interw.noDecisions')}
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {(
                      ['hired', 'shortlisted', 'maybe', 'rejected'] as const
                    ).map((key) => (
                      <li
                        key={key}
                        className="flex items-center justify-between gap-3 text-sm"
                      >
                        <DecisionBadge decision={key} />
                        <span className="tabular-nums">
                          {data.decisions[key]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </main>
  )
}
