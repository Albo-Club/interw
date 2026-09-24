import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useConvexAction,
  useConvexMutation,
  useConvexQuery,
} from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { CircleAlert, Mic, Play, Square, WifiOff } from 'lucide-react'

import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { Recording } from '~/lib/media/recorder'
import type { InterviewState, StopReason } from '~/lib/interview-machine'
import { fireAndForget } from '~/lib/fire-and-forget'
import { convexErrorCode } from '~/lib/convex-errors'
import { classifyMediaError, openInterviewStream } from '~/lib/media/devices'
import { SegmentRecorder, detectRecorderSupport } from '~/lib/media/recorder'
import { uploadToSignedUrl } from '~/lib/media/upload'
import {
  initialInterviewState,
  interviewReducer,
} from '~/lib/interview-machine'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import {
  CandidateShell,
  candidateAction,
} from '~/components/candidate/CandidateShell'
import { CandidateError } from '~/components/candidate/CandidateError'
import { cn } from '~/lib/utils'

type DeviceChoice = { camera?: string; mic?: string }

export const Route = createFileRoute('/s/$token/interview')({
  // The devices picked on the check screen. They travel in the URL because
  // the check and the interview are two routes, and without them the
  // interview reopened the system defaults — recording on the microphone
  // the candidate had just rejected.
  validateSearch: (search: Record<string, unknown>): DeviceChoice => ({
    camera: typeof search.camera === 'string' ? search.camera : undefined,
    mic: typeof search.mic === 'string' ? search.mic : undefined,
  }),
  component: InterviewRunner,
  errorComponent: CandidateError,
})

/** The countdown appears for the last 30 seconds, never before. */
const COUNTDOWN_THRESHOLD_SECONDS = 30

/** The i18n key for a failure, whichever layer it came from. */
function errorKey(cause: unknown): string {
  const media = classifyMediaError(cause)
  if (media) return `interview:device.${media}`
  const code = convexErrorCode(cause)
  return code ? `interview:errors.${code}` : 'interview:errors.unexpected'
}

const detail = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'unknown'

function InterviewRunner() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const devices = Route.useSearch()
  const navigate = useNavigate()

  const [now] = useState(() => Date.now())
  const data = useConvexQuery(api.interview.questions, { token, now })
  const start = useConvexMutation(api.interview.start)
  const requestUpload = useConvexAction(api.interview.requestSegmentUpload)
  const markUploaded = useConvexMutation(api.interview.markSegmentUploaded)
  const markFailed = useConvexMutation(api.interview.markSegmentFailed)
  const logEvent = useConvexMutation(api.interview.logEvent)
  const finish = useConvexMutation(api.interview.finish)
  const promptMedia = useConvexAction(api.interview.promptMediaUrls)

  const [state, dispatch] = useReducer(interviewReducer, initialInterviewState)
  // A boot failure goes to the route's error boundary, which knows how to
  // say "this interview has closed" as well as "something broke".
  const [fatal, setFatal] = useState<unknown>(null)
  const [elapsed, setElapsed] = useState(0)
  const [online, setOnline] = useState(true)
  const [media, setMedia] = useState<{
    intro: string | null
    questions: Record<string, string>
  }>({ intro: null, questions: {} })
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [audioOnly, setAudioOnly] = useState(false)
  const [preview, setPreview] = useState<HTMLVideoElement | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<SegmentRecorder | null>(null)
  // The finished recording, held until it is confirmed uploaded. This is what
  // makes "Try again" mean something: by the time the failure is on screen the
  // recorder is gone, so the retry has to re-send these bytes.
  const recordingRef = useRef<Recording | null>(null)
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bootedRef = useRef(false)

  const questions = data?.questions ?? []
  const current = questions.at(state.index)

  /* ── Connectivity. A candidate who goes offline mid-answer must be told,
        while it is happening, not after they press finish. ───────────────── */
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => {
      setOnline(false)
      fireAndForget(logEvent({ token, kind: 'network_degraded' }), 'candidate event log')
    }
    setOnline(navigator.onLine)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [logEvent, token])

  /* ── Closing the tab mid-upload loses the answer, so say so. ───────────── */
  useEffect(() => {
    if (state.phase !== 'saving' && state.phase !== 'recording') return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [state.phase])

  /* ── One camera acquisition for the interview, reopened only if a track
        died: re-requesting between questions makes the preview flicker and,
        on Safari, can re-prompt. ────────────────────────────────────────── */
  const openStream = useCallback(async (): Promise<MediaStream> => {
    const open = streamRef.current
    if (open?.getTracks().every((track) => track.readyState === 'live')) {
      return open
    }
    open?.getTracks().forEach((track) => track.stop())
    const opened = await openInterviewStream({
      cameraId: devices.camera,
      micId: devices.mic,
      video: detectRecorderSupport().video !== null,
    })
    streamRef.current = opened.stream
    setStream(opened.stream)
    setAudioOnly(opened.audioOnly)
    return opened.stream
  }, [devices.camera, devices.mic])

  // The preview is attached whenever both the stream and the element exist,
  // whichever arrives last. It used to be attached once, at acquisition —
  // which happened while the skeleton was on screen and the element did not
  // exist yet, so the candidate recorded their whole interview to a black box.
  useEffect(() => {
    if (!preview || !stream) return
    preview.srcObject = stream
    fireAndForget(preview.play(), 'camera preview autoplay')
  }, [preview, stream])

  useEffect(() => {
    return () => {
      if (autoStopRef.current) clearTimeout(autoStopRef.current)
      recorderRef.current?.dispose()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  /* ── Boot, once: mark the session started, resolve the question media, and
        start where the server says. The client has no resume logic. ─────── */
  useEffect(() => {
    if (!data || bootedRef.current) return
    bootedRef.current = true
    void (async () => {
      try {
        await start({ token })
        const urls = await promptMedia({ token })
        setMedia({
          intro: urls.intro,
          questions: Object.fromEntries(
            urls.questions.map((q) => [q.questionId, q.url]),
          ),
        })
      } catch (cause) {
        setFatal(cause)
        return
      }
      dispatch({
        type: 'booted',
        resumeAt: data.nextQuestionIndex,
        total: data.questions.length,
        showIntro:
          data.introMode !== 'none' && data.questions.every((q) => !q.answered),
      })
      try {
        await openStream()
      } catch (cause) {
        dispatch({ type: 'deviceFailed', error: errorKey(cause) })
      }
    })()
  }, [data, start, promptMedia, openStream, token])

  const answered = useCallback(
    () => questions.map((question) => question.answered),
    [questions],
  )

  /** Send (or re-send) the recording held for `question`. */
  const send = useCallback(
    async (question: (typeof questions)[number]) => {
      const recording = recordingRef.current
      if (!recording) return
      let segmentId: Id<'segments'> | null = null
      try {
        const slot = await requestUpload({
          token,
          questionIndex: question.orderIndex,
          audio: {
            mimeType: recording.audioMimeType,
            contentLength: recording.audio.size,
          },
          video:
            recording.video && recording.videoMimeType
              ? {
                  mimeType: recording.videoMimeType,
                  contentLength: recording.video.size,
                }
              : undefined,
        })
        segmentId = slot.segmentId
        const video = slot.video && recording.video ? recording.video : null
        const total = recording.audio.size + (video?.size ?? 0)

        await uploadToSignedUrl({
          url: slot.audio.uploadUrl,
          blob: recording.audio,
          contentType: slot.audio.contentType,
          onProgress: ({ loaded }) =>
            dispatch({ type: 'progress', loaded, total }),
        })
        // The answer is the audio — it is what gets transcribed — so it is
        // saved the moment the audio arrives. The video enriches it: losing
        // it is logged and said, and never costs the answer.
        await markUploaded({
          token,
          segmentId: slot.segmentId,
          durationSeconds: recording.durationSeconds,
        })

        let videoLost = false
        if (slot.video && video) {
          try {
            await uploadToSignedUrl({
              url: slot.video.uploadUrl,
              blob: video,
              contentType: slot.video.contentType,
              onProgress: ({ loaded }) =>
                dispatch({
                  type: 'progress',
                  loaded: recording.audio.size + loaded,
                  total,
                }),
            })
          } catch (cause) {
            videoLost = true
            fireAndForget(
              logEvent({
                token,
                kind: 'upload_failed',
                detail: `video: ${detail(cause)}`,
              }),
              'candidate event log',
            )
          }
        }
        recordingRef.current = null
        dispatch({ type: 'saved', answered: answered(), videoLost })
      } catch (cause) {
        // The server already holds this answer: an earlier attempt landed
        // and only its response was lost. That is a success.
        if (convexErrorCode(cause) === 'already_answered') {
          recordingRef.current = null
          dispatch({ type: 'saved', answered: answered(), videoLost: false })
          return
        }
        dispatch({ type: 'saveFailed', error: errorKey(cause) })
        // Recorded against the reserved segment as well as the event log, so
        // a recruiter looking at a short interview can see that an answer was
        // attempted and did not arrive, rather than assume it was skipped.
        if (segmentId) {
          fireAndForget(
            markFailed({ token, segmentId, detail: detail(cause) }),
            'segment failure report',
          )
        }
        fireAndForget(
          logEvent({ token, kind: 'upload_failed', detail: detail(cause) }),
          'candidate event log',
        )
      }
    },
    [requestUpload, markUploaded, markFailed, logEvent, answered, token],
  )

  const stopAndSave = useCallback(
    async (reason: StopReason) => {
      const recorder = recorderRef.current
      if (!recorder?.isRecording || !current) return
      recorderRef.current = null
      if (autoStopRef.current) clearTimeout(autoStopRef.current)
      dispatch({ type: 'stopRequested', reason })

      try {
        recordingRef.current = await recorder.stop()
      } catch (cause) {
        dispatch({ type: 'stopFailed', error: 'interview:run.recordingLost.body' })
        fireAndForget(
          logEvent({
            token,
            kind: 'upload_failed',
            detail: `recorder: ${detail(cause)}`,
          }),
          'candidate event log',
        )
        return
      }
      dispatch({ type: 'recorded' })
      await send(current)
    },
    [current, send, logEvent, token],
  )

  /* ── A phone that goes to the background, or a headset unplugged, keeps
        "recording" an empty track that nobody sees. Stop there, keep what was
        said, and tell the candidate. ─────────────────────────────────────── */
  useEffect(() => {
    if (state.phase !== 'recording') return
    const interrupt = () => void stopAndSave('interrupted')
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') interrupt()
    }
    const tracks = streamRef.current?.getTracks() ?? []
    document.addEventListener('visibilitychange', onVisibility)
    tracks.forEach((track) => track.addEventListener('ended', interrupt))
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      tracks.forEach((track) => track.removeEventListener('ended', interrupt))
    }
  }, [state.phase, stopAndSave])

  const beginRecording = async () => {
    if (!current) return
    try {
      const live = await openStream()
      const recorder = new SegmentRecorder(
        live,
        detectRecorderSupport(),
        ({ elapsedSeconds }) => setElapsed(elapsedSeconds),
      )
      recorder.start()
      recorderRef.current = recorder
      setElapsed(0)
      dispatch({ type: 'recordingStarted' })
      fireAndForget(logEvent({ token, kind: 'recording_started' }), 'candidate event log')

      // Hard stop at the limit the recruiter set. Without silence detection in
      // scope, this and the finish button are the only two ways an answer ends.
      autoStopRef.current = setTimeout(
        () => void stopAndSave('timeUp'),
        current.maxResponseSeconds * 1000,
      )
    } catch (cause) {
      dispatch({ type: 'recordingFailed', error: errorKey(cause) })
    }
  }

  const retry = () => {
    if (!current) return
    dispatch({ type: 'retry' })
    void send(current)
  }

  const skip = () => {
    recordingRef.current = null
    dispatch({ type: 'skip', answered: answered() })
  }

  const finishInterview = async () => {
    dispatch({ type: 'finishRequested' })
    try {
      await finish({ token })
      streamRef.current?.getTracks().forEach((track) => track.stop())
      await navigate({ to: '/s/$token/done', params: { token } })
    } catch (cause) {
      dispatch({ type: 'finishFailed', error: errorKey(cause) })
    }
  }

  if (fatal) throw fatal

  if (data === undefined || state.phase === 'loading') {
    return (
      <CandidateShell width="wide">
        <div className="space-y-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="aspect-[3/4] w-full rounded-lg sm:aspect-video" />
        </div>
      </CandidateShell>
    )
  }

  if (state.phase === 'intro') {
    return (
      <CandidateShell width="wide">
        <div className="space-y-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('interview:run.intro.title')}
          </h1>
          {media.intro ? (
            <video
              src={media.intro}
              controls
              playsInline
              className="bg-muted aspect-video w-full rounded-lg"
            />
          ) : (
            <p className="max-w-prose leading-relaxed">{data.introText}</p>
          )}
          <Button
            size="lg"
            className={candidateAction}
            onClick={() => dispatch({ type: 'introDone' })}
          >
            {t('interview:run.intro.continue')}
          </Button>
        </div>
      </CandidateShell>
    )
  }

  const inReview =
    state.phase === 'review' ||
    state.phase === 'finishing' ||
    state.phase === 'finishFailed'

  return (
    <CandidateShell width="wide">
      <div className="space-y-6">
        <LiveStatus state={state} />

        {!online && (
          <Alert>
            <WifiOff className="size-4" />
            <AlertDescription>{t('interview:run.offline')}</AlertDescription>
          </Alert>
        )}

        <LastAnswerNotice state={state} />

        {inReview ? (
          <ReviewScreen
            state={state}
            missing={questions.flatMap((question, index) =>
              question.answered ? [] : [index],
            )}
            onRevisit={(index) => dispatch({ type: 'revisit', index })}
            onFinish={() => void finishInterview()}
          />
        ) : (
          current && (
            <>
              <div className="space-y-2">
                <p className="text-muted-foreground text-sm tabular-nums">
                  {t('interview:run.progress', {
                    index: state.index + 1,
                    total: state.total,
                  })}
                </p>
                <Progress value={((state.index + 1) / state.total) * 100} />
              </div>

              <section className="space-y-4 rounded-lg border p-5">
                {current.hasMedia && media.questions[current.questionId] ? (
                  <video
                    key={current.questionId}
                    src={media.questions[current.questionId]}
                    controls
                    playsInline
                    className="bg-muted aspect-video w-full rounded-md"
                  />
                ) : null}
                <div className="space-y-2">
                  <h1 className="text-xl leading-relaxed font-medium">
                    {current.content}
                  </h1>
                  {current.hintText && (
                    <p className="text-muted-foreground text-sm">
                      {t('interview:run.hint')} — {current.hintText}
                    </p>
                  )}
                </div>
              </section>

              <CameraPreview
                ref={setPreview}
                audioOnly={audioOnly}
                recording={state.phase === 'recording'}
                remaining={Math.max(0, current.maxResponseSeconds - elapsed)}
              />

              {state.error && state.phase === 'prompt' && (
                <Alert variant="destructive">
                  <CircleAlert className="size-4" />
                  <AlertDescription>
                    {t(state.error, {
                      defaultValue: t('interview:errors.unexpected'),
                    })}
                  </AlertDescription>
                </Alert>
              )}

              {state.phase === 'saveFailed' && (
                <SaveFailed
                  hasRecording={state.hasRecording}
                  onRetry={retry}
                  onRerecord={() => dispatch({ type: 'rerecord' })}
                  onSkip={skip}
                />
              )}

              {state.phase === 'saving' && <Saving state={state} />}

              {/* The finish button is the only thing that ends an answer, so
                  it is always in the same place and never below the fold. */}
              <div className="bg-background sticky bottom-0 flex flex-wrap gap-3 border-t py-4">
                {state.phase === 'recording' ? (
                  <Button
                    size="lg"
                    className={candidateAction}
                    onClick={() => void stopAndSave('finished')}
                  >
                    <Square className="size-4" />
                    {t('interview:run.finishAnswer')}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    className={candidateAction}
                    onClick={() => void beginRecording()}
                    disabled={state.phase !== 'prompt'}
                  >
                    <Play className="size-4" />
                    {t('interview:run.startAnswer')}
                  </Button>
                )}
                {state.phase === 'recording' &&
                  current.maxResponseSeconds - elapsed <=
                    COUNTDOWN_THRESHOLD_SECONDS && (
                    <p className="text-warning-strong self-center text-sm tabular-nums">
                      {t('interview:run.timeUpSoon', {
                        seconds: Math.max(
                          0,
                          current.maxResponseSeconds - elapsed,
                        ),
                      })}
                    </p>
                  )}
              </div>
            </>
          )
        )}
      </div>
    </CandidateShell>
  )
}

/**
 * Portrait on a phone, landscape from `sm` up: a phone held upright gives a
 * portrait stream, and a 16:9 box cropped the candidate to a strip of face —
 * the only feedback they have on their framing.
 */
function CameraPreview({
  ref,
  audioOnly,
  recording,
  remaining,
}: {
  ref: (element: HTMLVideoElement | null) => void
  audioOnly: boolean
  recording: boolean
  remaining: number
}) {
  const { t } = useTranslation('interview')
  return (
    <div
      className={cn(
        'bg-muted relative aspect-[3/4] w-full overflow-hidden rounded-lg sm:aspect-video',
        recording && 'ring-destructive ring-2',
      )}
    >
      {audioOnly ? (
        <div className="text-muted-foreground flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-sm">
          <Mic className="size-8" />
          <p className="max-w-sm leading-relaxed">{t('run.audioOnly')}</p>
        </div>
      ) : (
        <video
          ref={ref}
          muted
          playsInline
          className="size-full scale-x-[-1] object-cover"
        />
      )}
      {recording && (
        <div className="bg-destructive text-destructive-foreground absolute top-3 left-3 flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium">
          {/* The dot pulses to say "live". It stops under
              prefers-reduced-motion — a candidate is looking at this screen
              for minutes, and the badge still reads as recording without it. */}
          <span className="size-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
          {t('run.recording')}
        </div>
      )}
      {recording && remaining <= COUNTDOWN_THRESHOLD_SECONDS && (
        <div className="bg-warning text-warning-foreground absolute top-3 right-3 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums">
          {t('run.timeLeft', { seconds: remaining })}
        </div>
      )}
    </div>
  )
}

/**
 * What a screen reader hears when the state changes. Polite, and worded once
 * per change — the countdown is announced when it starts, not every second.
 */
function LiveStatus({ state }: { state: InterviewState }) {
  const { t } = useTranslation('interview')
  const message =
    state.phase === 'recording'
      ? t('run.recording')
      : state.phase === 'saving'
        ? t('run.sending')
        : state.phase === 'prompt' && state.stopReason !== null
          ? t('run.saved')
          : ''
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  )
}

/** Why the last answer ended, when the candidate did not end it themselves. */
function LastAnswerNotice({ state }: { state: InterviewState }) {
  const { t } = useTranslation('interview')
  if (state.phase !== 'prompt' && state.phase !== 'review') return null
  const message = state.videoLost
    ? t('run.videoLost')
    : state.stopReason === 'timeUp'
      ? t('run.timeUp')
      : state.stopReason === 'interrupted'
        ? t('run.interrupted')
        : null
  if (!message) return null
  return (
    <Alert>
      <CircleAlert className="size-4" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function Saving({ state }: { state: InterviewState }) {
  const { t } = useTranslation('interview')
  const percent = state.progress
    ? Math.round((state.progress.loaded / Math.max(1, state.progress.total)) * 100)
    : 0
  return (
    <Alert>
      <AlertTitle>{t('run.sending')}</AlertTitle>
      <AlertDescription className="space-y-2">
        <Progress
          value={percent}
          aria-label={t('run.sending')}
          aria-valuetext={t('run.sendingPercent', { percent })}
        />
        <p className="tabular-nums">
          {t('run.sendingPercent', { percent })} · {t('run.sendingHint')}
        </p>
      </AlertDescription>
    </Alert>
  )
}

/**
 * A failed save always offers a way on. With bytes held, that is "Try again";
 * without — the recorder produced nothing — it is "Record it again", never a
 * retry of nothing.
 */
function SaveFailed({
  hasRecording,
  onRetry,
  onRerecord,
  onSkip,
}: {
  hasRecording: boolean
  onRetry: () => void
  onRerecord: () => void
  onSkip: () => void
}) {
  const { t } = useTranslation('interview')
  const copy = hasRecording ? 'run.sendFailed' : 'run.recordingLost'
  return (
    <Alert variant="destructive">
      <CircleAlert className="size-4" />
      <AlertTitle>{t(`${copy}.title`)}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t(`${copy}.body`)}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="lg"
            className={candidateAction}
            onClick={hasRecording ? onRetry : onRerecord}
          >
            {hasRecording
              ? t('run.sendFailed.retry')
              : t('run.recordingLost.rerecord')}
          </Button>
          <Button
            size="lg"
            variant="outline"
            className={candidateAction}
            onClick={onSkip}
          >
            {t('run.sendFailed.skip')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

/**
 * The end of the interview: what is missing, what happens next, and the
 * finish button — with its own failure rendered right here, next to it.
 */
function ReviewScreen({
  state,
  missing,
  onRevisit,
  onFinish,
}: {
  state: InterviewState
  missing: Array<number>
  onRevisit: (index: number) => void
  onFinish: () => void
}) {
  const { t } = useTranslation('interview')
  return (
    <div className="space-y-6 py-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        {t('run.review.title')}
      </h1>

      {missing.length === 0 ? (
        <p className="leading-relaxed">
          {t('run.review.allAnswered', { count: state.total })}
        </p>
      ) : (
        <section className="space-y-3">
          <p className="leading-relaxed">
            {t('run.review.missing', { count: missing.length })}
          </p>
          <ul className="space-y-2">
            {missing.map((index) => (
              <li
                key={index}
                className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <span className="font-medium">
                  {t('run.review.question', { index: index + 1 })}
                </span>
                <Button
                  variant="outline"
                  className={candidateAction}
                  onClick={() => onRevisit(index)}
                  disabled={state.phase === 'finishing'}
                >
                  {t('run.review.answer')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-muted-foreground max-w-prose leading-relaxed">
        {t('run.review.next')}
      </p>

      {state.phase === 'finishFailed' && state.error && (
        <Alert variant="destructive">
          <CircleAlert className="size-4" />
          <AlertDescription>
            {t(state.error, { defaultValue: t('errors.unexpected') })}
          </AlertDescription>
        </Alert>
      )}

      <Button
        size="lg"
        className={candidateAction}
        onClick={onFinish}
        disabled={state.phase === 'finishing'}
      >
        {state.phase === 'finishing'
          ? t('run.finishing')
          : t('run.finishInterview')}
      </Button>
    </div>
  )
}
