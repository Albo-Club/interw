import { useCallback, useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useConvexAction,
  useConvexMutation,
  useConvexQuery,
} from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { CircleAlert, Play, Square, WifiOff } from 'lucide-react'

import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { UploadProgress } from '~/lib/media/upload'
import type { Recording } from '~/lib/media/recorder'
import { fireAndForget } from '~/lib/fire-and-forget'
import { errorMessageKey } from '~/lib/convex-errors'
import { SegmentRecorder, detectRecorderSupport } from '~/lib/media/recorder'
import { uploadToSignedUrl } from '~/lib/media/upload'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { CandidateShell } from '~/components/candidate/CandidateShell'
import { InterviewCrash } from '~/components/candidate/InterviewCrash'
import { cn } from '~/lib/utils'

export const Route = createFileRoute('/s/$token/interview')({
  component: InterviewRunner,
  errorComponent: InterviewCrash,
})

/** The countdown appears for the last 30 seconds, never before. */
const COUNTDOWN_THRESHOLD_SECONDS = 30

type Phase =
  | 'loading'
  | 'intro'
  | 'prompt'
  | 'recording'
  | 'uploading'
  | 'failed'
  | 'finishing'

function InterviewRunner() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
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

  const [index, setIndex] = useState<number | null>(null)
  const [phase, setPhase] = useState<Phase>('loading')
  const [elapsed, setElapsed] = useState(0)
  const [upload, setUpload] = useState<UploadProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [online, setOnline] = useState(true)
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({})
  const [introUrl, setIntroUrl] = useState<string | null>(null)

  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<SegmentRecorder | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const promptVideoRef = useRef<HTMLVideoElement | null>(null)
  const autoStopRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const failedSegmentRef = useRef<Id<'segments'> | null>(null)
  // The finished recording, held until it is confirmed uploaded. This is what
  // makes "Try again" mean something: by the time the failure is on screen the
  // recorder is stopped and cleared, so the retry has to re-send these bytes,
  // not re-stop a recorder that is no longer running.
  const pendingRecordingRef = useRef<Recording | null>(null)

  const questions = data?.questions ?? []
  const current = index !== null ? questions[index] : undefined

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
    if (phase !== 'uploading' && phase !== 'recording') return
    const warn = (event: BeforeUnloadEvent) => event.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [phase])

  /* ── One camera acquisition for the whole interview: re-requesting between
        questions makes the preview flicker and, on Safari, can re-prompt. ── */
  const ensureStream = useCallback(async (): Promise<MediaStream> => {
    if (streamRef.current) return streamRef.current
    const support = detectRecorderSupport()
    const stream = await navigator.mediaDevices.getUserMedia({
      video: support.video !== null ? { width: 1280, height: 720 } : false,
      audio: true,
    })
    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      // Autoplay rejection is expected, not an error: browsers refuse it
      // without a user gesture, and the preview still renders the stream.
      await videoRef.current.play().catch(() => undefined)
    }
    return stream
  }, [])

  useEffect(() => {
    return () => {
      if (autoStopRef.current) clearTimeout(autoStopRef.current)
      recorderRef.current?.dispose()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  /* ── Boot: mark the session started, resolve the question media, and pick
        up at the first unanswered question. ─────────────────────────────── */
  useEffect(() => {
    if (!data || index !== null) return
    // An object rather than a `let`: the flag is mutated by the cleanup after
    // the closure is created, which TypeScript cannot see through a boolean.
    const run = { cancelled: false }
    void (async () => {
      try {
        await start({ token })
        const media = await promptMedia({ token, now: Date.now() })
        await ensureStream()
        // One cancellation check, after all the awaiting and before any state
        // is touched: nothing half-applies if the candidate navigated away.
        if (run.cancelled) return

        setIntroUrl(media.intro)
        setMediaUrls(
          Object.fromEntries(media.questions.map((q) => [q.questionId, q.url])),
        )
        const firstUnanswered = data.questions.findIndex((q) => !q.answered)
        setIndex(
          firstUnanswered === -1 ? data.questions.length : firstUnanswered,
        )
        const showIntro =
          data.introMode !== 'none' && data.questions.every((q) => !q.answered)
        setPhase(showIntro ? 'intro' : 'prompt')
      } catch (cause) {
        if (run.cancelled) return
        const { key, fallbackKey } = errorMessageKey(cause, 'interview')
        setError(t(key, { defaultValue: t(fallbackKey) }))
        setPhase('prompt')
        setIndex(0)
      }
    })()
    return () => {
      run.cancelled = true
    }
  }, [data, index, start, promptMedia, ensureStream, token, t])

  /** Send (or re-send) the recording currently held, and advance on success. */
  const uploadPending = useCallback(async () => {
    const recording = pendingRecordingRef.current
    if (!recording || current === undefined) return
    setPhase('uploading')
    setError(null)

    try {
      const slot = await requestUpload({
        token,
        questionIndex: current.orderIndex,
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
      failedSegmentRef.current = slot.segmentId

      // Audio first: it is what gets transcribed, so if only one of the two
      // makes it through a bad connection, it must be that one.
      await uploadToSignedUrl({
        url: slot.audio.uploadUrl,
        blob: recording.audio,
        contentType: slot.audio.contentType,
        onProgress: setUpload,
      })
      if (slot.video && recording.video) {
        await uploadToSignedUrl({
          url: slot.video.uploadUrl,
          blob: recording.video,
          contentType: slot.video.contentType,
          onProgress: setUpload,
        })
      }

      await markUploaded({
        token,
        segmentId: slot.segmentId,
        durationSeconds: recording.durationSeconds,
      })
      pendingRecordingRef.current = null
      failedSegmentRef.current = null
      setUpload(null)
      setPhase('prompt')
      setIndex((value) => (value === null ? null : value + 1))
    } catch (cause) {
      setPhase('failed')
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
      // Record the failure against the reserved segment as well as the event
      // log, so a recruiter looking at a short interview can see that an
      // answer was attempted and did not arrive — rather than assume the
      // candidate skipped it.
      if (failedSegmentRef.current) {
        fireAndForget(
          markFailed({
            token,
            segmentId: failedSegmentRef.current,
            detail: cause instanceof Error ? cause.message : 'unknown',
          }),
          'segment failure report',
        )
      }
      fireAndForget(
        logEvent({
          token,
          kind: 'upload_failed',
          detail: cause instanceof Error ? cause.message : 'unknown',
        }),
        'candidate event log',
      )
    }
  }, [current, requestUpload, markUploaded, markFailed, logEvent, token, t])

  const stopRecording = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder || !recorder.isRecording) return
    if (autoStopRef.current) clearTimeout(autoStopRef.current)
    setPhase('uploading')

    try {
      pendingRecordingRef.current = await recorder.stop()
      recorderRef.current = null
    } catch (cause) {
      setPhase('failed')
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
      return
    }
    await uploadPending()
  }, [uploadPending, t])

  const beginRecording = useCallback(async () => {
    if (current === undefined) return
    setError(null)
    try {
      const stream = await ensureStream()
      const support = detectRecorderSupport()
      const recorder = new SegmentRecorder(stream, support, ({ elapsedSeconds }) =>
        setElapsed(elapsedSeconds),
      )
      recorderRef.current = recorder
      recorder.start()
      setElapsed(0)
      setPhase('recording')
      fireAndForget(logEvent({ token, kind: 'recording_started' }), 'candidate event log')

      // Hard stop at the limit the recruiter set. Without silence detection in
      // scope, this and the finish button are the only two ways an answer ends.
      autoStopRef.current = setTimeout(
        () => void stopRecording(),
        current.maxResponseSeconds * 1000,
      )
    } catch (cause) {
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
    }
  }, [current, ensureStream, stopRecording, logEvent, token, t])

  const finishInterview = useCallback(async () => {
    setPhase('finishing')
    try {
      await finish({ token })
      streamRef.current?.getTracks().forEach((track) => track.stop())
      await navigate({ to: '/s/$token/done', params: { token } })
    } catch (cause) {
      setPhase('failed')
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
    }
  }, [finish, navigate, token, t])

  if (data === undefined || index === null) {
    return (
      <CandidateShell width="wide">
        <div className="space-y-6">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-24 w-full rounded-lg" />
          <Skeleton className="aspect-video w-full rounded-lg" />
        </div>
      </CandidateShell>
    )
  }

  const total = questions.length
  const finished = index >= total

  if (phase === 'intro') {
    return (
      <CandidateShell width="wide">
        <div className="space-y-6">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('interview:run.intro.title')}
          </h1>
          {introUrl ? (
            <video
              src={introUrl}
              controls
              playsInline
              className="bg-muted aspect-video w-full rounded-lg"
            />
          ) : (
            <p className="max-w-prose leading-relaxed">{data.introText}</p>
          )}
          <Button size="lg" onClick={() => setPhase('prompt')}>
            {t('interview:run.intro.continue')}
          </Button>
        </div>
      </CandidateShell>
    )
  }

  const remaining = current
    ? Math.max(0, current.maxResponseSeconds - elapsed)
    : 0
  const showCountdown =
    phase === 'recording' && remaining <= COUNTDOWN_THRESHOLD_SECONDS

  return (
    <CandidateShell width="wide">
      <div className="space-y-6">
        {!finished && (
          <div className="space-y-2">
            <p className="text-muted-foreground text-sm tabular-nums">
              {t('interview:run.progress', { index: index + 1, total })}
            </p>
            <Progress value={((index + 1) / total) * 100} />
          </div>
        )}

        {!online && (
          <Alert>
            <WifiOff className="size-4" />
            <AlertDescription>{t('interview:run.offline')}</AlertDescription>
          </Alert>
        )}

        {finished ? (
          <div className="space-y-6 py-6">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t('interview:run.finishInterview')}
            </h1>
            <Button
              size="lg"
              onClick={() => void finishInterview()}
              disabled={phase === 'finishing'}
            >
              {phase === 'finishing'
                ? t('interview:run.finishing')
                : t('interview:run.finishInterview')}
            </Button>
          </div>
        ) : (
          current && (
            <>
              <section className="space-y-4 rounded-lg border p-5">
                {current.hasMedia && mediaUrls[current.questionId] ? (
                  <video
                    ref={promptVideoRef}
                    key={current.questionId}
                    src={mediaUrls[current.questionId]}
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

              <div
                className={cn(
                  'bg-muted relative aspect-video w-full overflow-hidden rounded-lg',
                  phase === 'recording' && 'ring-destructive ring-2',
                )}
              >
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="size-full scale-x-[-1] object-cover"
                />
                {phase === 'recording' && (
                  <div className="bg-destructive text-destructive-foreground absolute top-3 left-3 flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium">
                    {/* The dot pulses to say "live". It stops under
                        prefers-reduced-motion — a candidate is looking at
                        this screen for minutes, and the badge still reads as
                        recording without it. */}
                    <span className="size-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
                    {t('interview:run.recording')}
                  </div>
                )}
                {showCountdown && (
                  <div className="bg-warning text-warning-foreground absolute top-3 right-3 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums">
                    {t('interview:run.timeLeft', { seconds: remaining })}
                  </div>
                )}
              </div>

              {error && phase === 'failed' && (
                <Alert variant="destructive">
                  <CircleAlert className="size-4" />
                  <AlertTitle>
                    {t('interview:run.sendFailed.title')}
                  </AlertTitle>
                  <AlertDescription className="space-y-3">
                    <p>{t('interview:run.sendFailed.body')}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => void uploadPending()}>
                        {t('interview:run.sendFailed.retry')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          pendingRecordingRef.current = null
                          failedSegmentRef.current = null
                          setError(null)
                          setPhase('prompt')
                          setIndex((value) =>
                            value === null ? null : value + 1,
                          )
                        }}
                      >
                        {t('interview:run.sendFailed.skip')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}

              {phase === 'uploading' && (
                <Alert>
                  <AlertTitle>
                    {upload?.phase === 'retrying'
                      ? t('interview:run.retrying', {
                          attempt: upload.attempt,
                          max: upload.maxAttempts,
                        })
                      : t('interview:run.sending')}
                  </AlertTitle>
                  <AlertDescription>
                    {t('interview:run.sendingHint')}
                  </AlertDescription>
                </Alert>
              )}

              {/* The finish button is the only thing that ends an answer, so
                  it is always in the same place and never below the fold. */}
              <div className="bg-background sticky bottom-0 flex flex-wrap gap-3 border-t py-4">
                {phase === 'recording' ? (
                  <Button size="lg" onClick={() => void stopRecording()}>
                    <Square className="size-4" />
                    {t('interview:run.finishAnswer')}
                  </Button>
                ) : (
                  <Button
                    size="lg"
                    onClick={() => void beginRecording()}
                    disabled={phase === 'uploading' || phase === 'finishing'}
                  >
                    <Play className="size-4" />
                    {t('interview:run.startAnswer')}
                  </Button>
                )}
                {showCountdown && (
                  <p className="text-warning-strong self-center text-sm tabular-nums">
                    {t('interview:run.timeUpSoon', { seconds: remaining })}
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
