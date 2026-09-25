import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useConvexAction,
  useConvexMutation,
  useConvexQuery,
} from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import {
  ArrowLeft,
  FileText,
  Play,
  RotateCw,
  Share2,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { SeekCue } from '~/components/report/AnswerPlayer'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { sessionMediaKey, useSessionMedia } from '~/hooks/useSessionMedia'
import { Button } from '~/components/ui/button'
import { Textarea } from '~/components/ui/textarea'
import { Skeleton } from '~/components/ui/skeleton'
import { Progress } from '~/components/ui/progress'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
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
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { AiDisclaimer } from '~/components/report/AiDisclaimer'
import { MemberName } from '~/components/MemberName'
import { ShareReportDialog } from '~/components/report/ShareReportDialog'
import { Highlights } from '~/components/report/Highlights'
import { MediaFailedAlert } from '~/components/report/MediaFailedAlert'
import {
  AnswerPlayer,
  formatTimecode,
} from '~/components/report/AnswerPlayer'
import {
  DecisionBadge,
  ScoreBadge,
  SessionStatusBadge,
} from '~/components/candidates/StatusBadge'
import { cn } from '~/lib/utils'
import { AppNotFound, AppRouteError } from '~/components/app-shell/RouteFallbacks'

export const Route = createFileRoute('/app/$orgSlug/candidates/$sessionId')({
  // The one place the URL segment becomes a session id. A malformed value is
  // refused by the functions' `v.id` validators and lands on `errorComponent`.
  params: {
    parse: (raw) => ({ sessionId: raw.sessionId as Id<'sessions'> }),
    stringify: (parsed) => ({ sessionId: parsed.sessionId }),
  },
  component: CandidateReportPage,
  errorComponent: AppRouteError,
  notFoundComponent: AppNotFound,
  head: () => ({
    meta: [
      { title: getI18n(getLocale()).getFixedT(null, 'report')('metaTitle') },
    ],
  }),
})

const DECISIONS = ['rejected', 'maybe', 'shortlisted', 'hired'] as const

function CandidateReportPage() {
  const { t } = useTranslation(['report', 'candidates', 'common'])
  const { orgSlug, sessionId } = Route.useParams()
  const locale = getLocale()

  const data = useConvexQuery(api.reports.forSession, {
    sessionId,
  })
  const mediaUrls = useConvexAction(api.reports.sessionMediaUrls)
  const setDecision = useConvexMutation(api.reports.setDecision)
  const setNote = useConvexMutation(api.reports.setNote)
  const relaunch = useConvexMutation(api.reports.relaunch)
  const deleteCandidate = useConvexAction(api.sessions.deleteCandidateData)
  const navigate = useNavigate()

  const {
    media,
    failed: mediaFailed,
    retry: retryMedia,
    onPlaybackError,
  } = useSessionMedia(data ? sessionMediaKey(data) : null, () =>
    mediaUrls({ sessionId, language: locale }),
  )
  const [cue, setCue] = useState<SeekCue>(null)
  const [activeSegment, setActiveSegment] = useState<string | null>(null)
  const [note, setNoteValue] = useState('')
  const [noteLoaded, setNoteLoaded] = useState(false)
  const [sharing, setSharing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [relaunching, setRelaunching] = useState(false)

  useEffect(() => {
    if (data && !noteLoaded) {
      setNoteValue(data.session.recruiterNote ?? '')
      setNoteLoaded(true)
    }
  }, [data, noteLoaded])

  const questionLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const answer of data?.answers ?? []) {
      labels[answer.segmentId] = t('report:answers.question', {
        index: answer.questionIndex + 1,
      })
    }
    return labels
  }, [data, t])
  const answerLengths = useMemo(
    () =>
      Object.fromEntries(
        (data?.answers ?? []).map((a) => [a.segmentId, a.durationSeconds]),
      ),
    [data],
  )

  if (data === undefined) {
    return (
      <main className="flex-1 space-y-6 p-6">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full rounded-lg" />
        <Skeleton className="h-96 w-full rounded-lg" />
      </main>
    )
  }

  const {
    session,
    project,
    criteria,
    answers,
    report,
    pipeline,
    canManage,
    decisionHistory,
  } = data
  const criterionLabel = new Map(criteria.map((c) => [c._id, c]))

  const jump = (segmentId: string, seconds: number) => {
    setActiveSegment(segmentId)
    setCue({ segmentId, seconds, nonce: Date.now() })
  }

  const saveNote = async () => {
    try {
      await setNote({ sessionId, note })
      toast.success(t('report:note.saved'))
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'report')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  const relaunchAnalysis = async () => {
    setRelaunching(true)
    try {
      await relaunch({ sessionId })
      toast.success(t('report:pending.relaunched'))
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'report')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setRelaunching(false)
    }
  }

  const lastFailure = pipeline.find((entry) => entry.outcome === 'failed')
  const answeredCount = answers.filter((a) => a.uploadState === 'uploaded').length

  return (
    <main className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Button variant="ghost" size="sm" asChild className="-ml-3">
            <Link
              to="/app/$orgSlug/projects/$projectSlug"
              params={{ orgSlug, projectSlug: project.slug }}
            >
              <ArrowLeft className="size-4" />
              {project.title}
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {session.candidateName}
            </h1>
            <SessionStatusBadge status={session.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            {session.candidateEmail}
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {report && (
            <Button variant="outline" onClick={() => setSharing(true)}>
              <Share2 className="size-4" />
              {t('report:share.title')}
            </Button>
          )}
          {/* Only for those the server lets delete (E9): offering a button
              that always fails is a dead end. */}
          {canManage && (
            <Button
              variant="ghost"
              className="text-destructive"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="size-4" />
              {t('candidates:actions.delete')}
            </Button>
          )}
        </div>
      </div>

      {/* ── The verdict, before anything else. ─────────────────────────── */}
      {report ? (
        <Card>
          <CardContent className="grid gap-6 pt-6 sm:grid-cols-[auto_1fr]">
            <div className="flex flex-col items-center justify-center gap-1 sm:pr-6">
              <span className="text-4xl font-semibold tabular-nums">
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
      ) : session.status === 'completed' ? (
        <Alert>
          <AlertTitle>
            {lastFailure
              ? t('report:pending.failedTitle')
              : t('report:pending.title')}
          </AlertTitle>
          <AlertDescription className="space-y-3">
            <p>
              {lastFailure
                ? t('report:pending.failedBody')
                : t('report:pending.body')}
            </p>
            {pipeline.length > 0 && (
              <ul className="text-muted-foreground space-y-1 text-xs">
                {pipeline.slice(0, 6).map((entry, index) => (
                  <li key={index} className="tabular-nums">
                    {t(`report:pending.steps.${entry.step}`)} ·{' '}
                    {t(`report:pending.outcome.${entry.outcome}`)} ·{' '}
                    {new Date(entry.at).toLocaleString(locale)}
                  </li>
                ))}
              </ul>
            )}
            {lastFailure && canManage && (
              <Button
                size="sm"
                variant="outline"
                disabled={relaunching}
                onClick={() => void relaunchAnalysis()}
              >
                <RotateCw
                  className={cn(
                    'size-4',
                    relaunching && 'motion-safe:animate-spin',
                  )}
                  aria-hidden
                />
                {t('report:pending.relaunch')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      ) : session.status === 'in_progress' ? (
        <Alert>
          <AlertTitle>{t('report:inProgress.title')}</AlertTitle>
          <AlertDescription>
            {t('report:inProgress.body', {
              name: session.candidateName,
              answered: answeredCount,
              total: answers.length,
            })}
          </AlertDescription>
        </Alert>
      ) : session.status === 'expired' ? (
        <Alert>
          <AlertTitle>{t('report:expired.title')}</AlertTitle>
          <AlertDescription>
            {t('report:expired.body', { name: session.candidateName })}
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <AlertTitle>{t('report:notStarted.title')}</AlertTitle>
          <AlertDescription>
            {t('report:notStarted.body', { name: session.candidateName })}
          </AlertDescription>
        </Alert>
      )}

      {session.mediaPurgedAt && (
        <Alert>
          <AlertTitle>{t('report:mediaPurged.title')}</AlertTitle>
          <AlertDescription>
            {t('report:mediaPurged.body', {
              date: new Date(session.mediaPurgedAt).toLocaleDateString(locale),
            })}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-6">
          {/* ── Criteria, each with the proof under it. ────────────────── */}
          {report && report.fitMatrix && (
            <section className="space-y-4">
              <h2 className="text-lg font-semibold">
                {t('report:sections.criteria')}
              </h2>
              {report.fitMatrix.criteria.map((entry) => {
                const criterion = criterionLabel.get(entry.criterionId)
                const evidence = report.criteriaScores.find(
                  (score) => score.criterionId === entry.criterionId,
                )?.evidence
                return (
                  <Card key={entry.criterionId}>
                    <CardContent className="space-y-3 pt-6">
                      <div className="flex flex-wrap items-baseline justify-between gap-3">
                        <h3 className="font-medium">
                          {criterion?.label ?? ''}
                        </h3>
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
                      <p className="text-sm leading-relaxed">
                        {entry.statement}
                      </p>
                      {evidence && evidence.length > 0 && (
                        <ul className="space-y-2 border-l-2 pl-4">
                          {evidence.map((item, index) => (
                            <li key={index} className="space-y-1">
                              <p className="text-muted-foreground text-sm italic">
                                “{item.quote}”
                              </p>
                              {/* No offer to seek when the quote could not be
                                  anchored: a button that lands on the wrong
                                  moment is worse than no button. */}
                              {item.anchored &&
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
                            </li>
                          ))}
                        </ul>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </section>
          )}

          {report && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">
                    {t('report:sections.strengths')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
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
                <CardHeader>
                  <CardTitle className="text-base">
                    {t('report:sections.concerns')}
                  </CardTitle>
                </CardHeader>
                <CardContent>
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
          )}

          {/* ── Answer by answer. ──────────────────────────────────────── */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold">
              {t('report:sections.answers')}
            </h2>
            {answers.map((answer) => {
              const evaluation = report?.fitMatrix?.questions.find(
                (q) => q.questionIndex === answer.questionIndex,
              )
              return (
                <Card key={answer.segmentId}>
                  <CardContent className="space-y-3 pt-6">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase tabular-nums">
                        {t('report:answers.question', {
                          index: answer.questionIndex + 1,
                        })}
                      </span>
                      {evaluation && (
                        <span className="flex items-center gap-2 text-sm">
                          <span className="text-muted-foreground text-xs">
                            {t(`report:answers.depth.${evaluation.depth}`)}
                          </span>
                          <span className="font-semibold tabular-nums">
                            {t('report:answers.score', {
                              score: evaluation.score,
                            })}
                          </span>
                        </span>
                      )}
                    </div>
                    <p className="font-medium">{answer.question}</p>
                    {answer.uploadState === 'failed' ? (
                      <Alert variant="destructive">
                        <AlertDescription>
                          {t('report:answers.uploadFailed')}
                        </AlertDescription>
                      </Alert>
                    ) : (
                      <>
                        {evaluation && (
                          <p className="text-sm leading-relaxed">
                            {evaluation.summary}
                          </p>
                        )}
                        {evaluation?.evidence && (
                          <div className="space-y-1 border-l-2 pl-4">
                            <p className="text-muted-foreground text-sm italic">
                              “{evaluation.evidence.quote}”
                            </p>
                            {evaluation.evidence.anchored &&
                              evaluation.evidence.startSeconds !==
                                undefined && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    jump(
                                      evaluation.evidence!.segmentId,
                                      evaluation.evidence!.startSeconds!,
                                    )
                                  }
                                  className="text-primary inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
                                >
                                  <Play className="size-3" />
                                  {t('report:criteria.jump', {
                                    time: formatTimecode(
                                      evaluation.evidence.startSeconds,
                                    ),
                                  })}
                                </button>
                              )}
                          </div>
                        )}
                        {answer.transcript && (
                          <details className="text-sm">
                            <summary className="text-muted-foreground cursor-pointer text-xs">
                              {t('report:answers.showTranscript')}
                            </summary>
                            <p className="text-muted-foreground mt-2 leading-relaxed">
                              {answer.transcript}
                            </p>
                          </details>
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>
              )
            })}
          </section>
        </div>

        {/* ── Sidebar: the video, the decision. ──── */}
        <aside className="space-y-6">
          {mediaFailed && <MediaFailedAlert onRetry={retryMedia} />}

          {media && media.segments.length > 0 && (
            <AnswerPlayer
              segments={media.segments}
              cue={cue}
              activeSegmentId={activeSegment}
              onSelect={setActiveSegment}
              questionLabels={questionLabels}
              answerLengths={answerLengths}
              onError={onPlaybackError}
            />
          )}

          {report?.highlights && (
            <Highlights
              highlights={report.highlights}
              onJump={media && media.segments.length > 0 ? jump : null}
            />
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t('candidates:decision.set')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {DECISIONS.map((decision) => (
                  <Button
                    key={decision}
                    size="sm"
                    variant={
                      session.recruiterDecision === decision
                        ? 'default'
                        : 'outline'
                    }
                    onClick={() =>
                      void setDecision({
                        sessionId,
                        decision:
                          session.recruiterDecision === decision
                            ? null
                            : decision,
                      })
                        .then(() =>
                          toast.success(t('candidates:decision.saved')),
                        )
                        .catch((error: unknown) => {
                          // A decision that did not save must not look saved.
                          const { key, fallbackKey } = errorMessageKey(
                            error,
                            'candidates',
                          )
                          toast.error(
                            t(key, { defaultValue: t(fallbackKey) }),
                          )
                        })
                    }
                  >
                    {t(`candidates:decision.${decision}`)}
                  </Button>
                ))}
              </div>
              {session.recruiterDecisionBy && (
                <p className="text-muted-foreground text-xs">
                  <DecisionBadge decision={session.recruiterDecision} />{' '}
                  <MemberName member={session.recruiterDecisionBy} />
                </p>
              )}
              {decisionHistory.length > 0 && (
                <details className="text-xs">
                  <summary className="text-muted-foreground cursor-pointer">
                    {t('candidates:decision.history')}
                  </summary>
                  <ol className="mt-2 space-y-1.5">
                    {decisionHistory.map((event, index) => (
                      <li
                        key={index}
                        className="flex flex-wrap items-baseline gap-x-2"
                      >
                        <span className="font-medium">
                          {event.decision
                            ? t(`candidates:decision.${event.decision}`)
                            : t('candidates:decision.cleared')}
                        </span>
                        <span className="text-muted-foreground min-w-0 break-words">
                          <MemberName member={event.by} />
                        </span>
                        <time
                          dateTime={new Date(event.at).toISOString()}
                          className="text-muted-foreground tabular-nums"
                        >
                          {new Date(event.at).toLocaleString(locale)}
                        </time>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </CardContent>
          </Card>

          {(media?.cv || media?.coverLetter) && (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {t('report:sections.documents')}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {media.cv && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={media.cv} target="_blank" rel="noopener noreferrer">
                      <FileText className="size-4" aria-hidden />
                      {t('report:documents.cv')}
                      <span className="sr-only">
                        {' '}
                        {t('report:documents.newTab')}
                      </span>
                    </a>
                  </Button>
                )}
                {media.coverLetter && (
                  <Button variant="outline" size="sm" asChild>
                    <a
                      href={media.coverLetter}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <FileText className="size-4" aria-hidden />
                      {t('report:documents.coverLetter')}
                      <span className="sr-only">
                        {' '}
                        {t('report:documents.newTab')}
                      </span>
                    </a>
                  </Button>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t('report:sections.note')}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <Textarea
                rows={5}
                value={note}
                placeholder={t('report:note.placeholder')}
                onChange={(event) => setNoteValue(event.target.value)}
                onBlur={() => void saveNote()}
              />
              <p className="text-muted-foreground text-xs">
                {t('report:note.hint')}
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <ShareReportDialog
        sessionId={sessionId}
        open={sharing}
        onOpenChange={setSharing}
      />

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('candidates:deleteConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('candidates:deleteConfirm.body', {
                name: session.candidateName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void deleteCandidate({ sessionId })
                  .then(() =>
                    navigate({
                      to: '/app/$orgSlug/projects/$projectSlug',
                      params: { orgSlug, projectSlug: project.slug },
                    }),
                  )
                  .catch((error: unknown) => {
                    const { key, fallbackKey } = errorMessageKey(
                      error,
                      'candidates',
                    )
                    toast.error(t(key, { defaultValue: t(fallbackKey) }))
                  })
              }}
            >
              {t('candidates:deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  )
}
