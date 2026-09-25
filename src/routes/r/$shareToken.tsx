import { useEffect, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useConvexAction, useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { Play } from 'lucide-react'

import { api } from '../../../convex/_generated/api'
import type { SeekCue } from '~/components/report/AnswerPlayer'
import { getI18n } from '~/lib/i18n'
import { fireAndForget } from '~/lib/fire-and-forget'
import { getLocale } from '~/lib/locale'
import { useSessionMedia } from '~/hooks/useSessionMedia'
import { Skeleton } from '~/components/ui/skeleton'
import { Progress } from '~/components/ui/progress'
import { Card, CardContent } from '~/components/ui/card'
import { AiDisclaimer } from '~/components/report/AiDisclaimer'
import { MediaFailedAlert } from '~/components/report/MediaFailedAlert'
import { AnswerPlayer, formatTimecode } from '~/components/report/AnswerPlayer'
import { ScoreBadge } from '~/components/candidates/StatusBadge'
import { cn } from '~/lib/utils'

/**
 * A report shared outside the account.
 *
 * Read-only, unauthenticated, and `noindex` — a crawler finding one of these
 * would put a named person's assessment in a search result.
 */
export const Route = createFileRoute('/r/$shareToken')({
  component: SharedReport,
  head: () => ({
    meta: [
      { title: getI18n(getLocale()).getFixedT(null, 'report')('shared.title') },
      { name: 'robots', content: 'noindex, nofollow' },
      { name: 'referrer', content: 'no-referrer' },
    ],
  }),
})

function SharedReport() {
  const { t } = useTranslation(['report', 'common'])
  const { shareToken } = Route.useParams()
  const locale = getLocale()
  const [now] = useState(() => Date.now())

  const data = useConvexQuery(api.shares.view, { token: shareToken, now })
  const recordView = useConvexMutation(api.shares.recordView)
  const sharedMedia = useConvexAction(api.shares.sharedMediaUrls)

  const [cue, setCue] = useState<SeekCue>(null)
  const [activeSegment, setActiveSegment] = useState<string | null>(null)

  // Signed on the token alone: a revoked or expired link drops the key, and
  // nothing else about the report changes what there is to play.
  const {
    media,
    failed: mediaFailed,
    retry: retryMedia,
    onPlaybackError,
  } = useSessionMedia(data?.state === 'active' ? shareToken : null, () =>
    sharedMedia({ token: shareToken }),
  )

  useEffect(() => {
    if (data?.state !== 'active') return
    fireAndForget(recordView({ token: shareToken }), 'share view counter')
  }, [data?.state, recordView, shareToken])

  if (data === undefined) {
    return (
      <Frame>
        <Skeleton className="h-40 w-full rounded-lg" />
      </Frame>
    )
  }

  // The union is discriminated on `state`, so this narrows `report` too.
  if (data.state !== 'active') {
    const key =
      data.state === 'expired'
        ? 'expired'
        : data.state === 'revoked'
          ? 'revoked'
          : 'notFound'
    return (
      <Frame>
        <div className="space-y-3 py-10">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t(`report:shared.${key}.title`)}
          </h1>
          <p className="text-muted-foreground max-w-prose leading-relaxed">
            {t(`report:shared.${key}.body`)}
          </p>
        </div>
      </Frame>
    )
  }

  const report = data.report
  const criterionById = new Map(report.criteria.map((c) => [c._id, c]))
  const kindBySegment = new Map(
    report.answers.map((answer) => [answer.segmentId, answer.mediaKind]),
  )
  const questionLabels = Object.fromEntries(
    report.answers.map((answer) => [
      answer.segmentId,
      t('report:answers.question', { index: answer.questionIndex + 1 }),
    ]),
  )
  const answerLengths = Object.fromEntries(
    report.answers.map((a) => [a.segmentId, a.durationSeconds]),
  )

  const jump = (segmentId: string, seconds: number) => {
    setActiveSegment(segmentId)
    setCue({ segmentId, seconds, nonce: Date.now() })
  }

  return (
    <Frame organisation={report.organisationName}>
      <div className="space-y-8">
        <header className="space-y-2">
          <p className="text-muted-foreground text-sm">
            {t('report:shared.sharedBy', { org: report.organisationName })}
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">
            {report.candidateName}
          </h1>
          {report.jobTitle && (
            <p className="text-muted-foreground">{report.jobTitle}</p>
          )}
        </header>

        <Card>
          <CardContent className="grid gap-6 pt-6 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center justify-center sm:pr-6">
              <span className="text-4xl font-semibold">
                <ScoreBadge score={report.overallScore} />
              </span>
              <span className="text-muted-foreground text-xs">
                {t('report:verdict.outOf')}
              </span>
            </div>
            <div className="space-y-3">
              <div className="flex flex-wrap items-baseline gap-3">
                <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {t('report:verdict.recommendation')}
                </span>
                <span className="text-lg font-semibold">
                  {t(`report:verdict.${report.recommendation}`)}
                </span>
              </div>
              <p className="leading-relaxed whitespace-pre-line">
                {report.executiveSummary}
              </p>
              <AiDisclaimer variant="full" />
            </div>
          </CardContent>
        </Card>

        {mediaFailed && <MediaFailedAlert onRetry={retryMedia} />}

        {media && media.length > 0 && (
          <AnswerPlayer
            segments={media.map((entry) => ({
              ...entry,
              // An answer recorded without a camera is audio: a <video> over
              // it is a black box with a play button.
              kind: kindBySegment.get(entry.segmentId) ?? 'video',
            }))}
            cue={cue}
            activeSegmentId={activeSegment}
            onSelect={setActiveSegment}
            questionLabels={questionLabels}
            answerLengths={answerLengths}
            onError={onPlaybackError}
          />
        )}

        {report.fitMatrix && (
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t('report:sections.criteria')}
            </h2>
            {report.fitMatrix.criteria.map((entry) => {
              const criterion = criterionById.get(entry.criterionId)
              const evidence = report.criteriaScores.find(
                (score) => score.criterionId === entry.criterionId,
              )?.evidence
              return (
                <Card key={entry.criterionId}>
                  <CardContent className="space-y-3 pt-6">
                    <div className="flex flex-wrap items-baseline justify-between gap-3">
                      <h3 className="font-medium">{criterion?.label ?? ''}</h3>
                      <div className="flex items-center gap-3 text-sm">
                        <span className="text-muted-foreground tabular-nums">
                          {t('report:criteria.weight', {
                            percent: criterion?.normalizedWeight ?? 0,
                          })}
                        </span>
                        <span
                          className={cn(
                            'rounded-full px-2 py-0.5 text-xs font-medium',
                            entry.level === 'excellent' &&
                              'bg-success-subtle text-success-strong',
                            entry.level === 'solid' &&
                              'bg-info-subtle text-info-strong',
                            entry.level === 'partial' &&
                              'bg-warning-subtle text-warning-strong',
                            entry.level === 'gap' &&
                              'bg-destructive-subtle text-destructive-strong',
                          )}
                        >
                          {t(`report:criteria.level.${entry.level}`)}
                        </span>
                        <ScoreBadge score={entry.score} />
                      </div>
                    </div>
                    <Progress value={entry.score} />
                    <p className="text-sm leading-relaxed">{entry.statement}</p>
                    {evidence?.map((item, index) => (
                      <div key={index} className="space-y-1 border-l-2 pl-4">
                        <p className="text-muted-foreground text-sm italic">
                          “{item.quote}”
                        </p>
                        {/* No offer to seek when the quote could not be
                            anchored: a button that lands on the wrong moment
                            is worse than no button. */}
                        {media &&
                          media.length > 0 &&
                          item.anchored &&
                          item.startSeconds !== undefined && (
                            <button
                              type="button"
                              onClick={() =>
                                jump(item.segmentId, item.startSeconds!)
                              }
                              className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                            >
                              <Play className="size-3" />
                              {t('report:criteria.jump', {
                                time: formatTimecode(item.startSeconds),
                              })}
                            </button>
                          )}
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )
            })}
          </section>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardContent className="space-y-2 pt-6">
              <h3 className="font-medium">{t('report:sections.strengths')}</h3>
              {report.strengths.length === 0 ? (
                <p className="text-muted-foreground text-sm">—</p>
              ) : (
                <ul className="list-disc space-y-1.5 pl-4 text-sm leading-relaxed">
                  {report.strengths.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="space-y-2 pt-6">
              <h3 className="font-medium">{t('report:sections.concerns')}</h3>
              {report.concerns.length === 0 ? (
                <p className="text-muted-foreground text-sm">—</p>
              ) : (
                <ul className="list-disc space-y-1.5 pl-4 text-sm leading-relaxed">
                  {report.concerns.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {report.completedAt && (
          <p className="text-muted-foreground text-xs">
            {t('report:verdict.generated', {
              date: new Date(report.completedAt).toLocaleDateString(locale),
            })}
          </p>
        )}
      </div>
    </Frame>
  )
}

function Frame({
  organisation,
  children,
}: {
  organisation?: string
  children: React.ReactNode
}) {
  return (
    <div className="bg-background flex min-h-svh flex-col">
      <header className="border-b">
        <div className="mx-auto flex h-14 max-w-4xl items-center px-4">
          <span className="text-sm font-semibold tracking-tight">
            {organisation ?? 'interw'}
          </span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-4xl flex-1 px-4 py-10">
        {children}
      </main>
    </div>
  )
}
