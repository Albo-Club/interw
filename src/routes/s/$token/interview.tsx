import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { createFileRoute, useBlocker, useNavigate } from '@tanstack/react-router'
import {
  useConvexAction,
  useConvexMutation,
  useConvexQuery,
} from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { CircleAlert, Play, Square, WifiOff } from 'lucide-react'

import { api } from '../../../../convex/_generated/api'
import type { FunctionArgs } from 'convex/server'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { Recording } from '~/lib/media/recorder'
import type { UploadProgress } from '~/lib/media/upload'
import type { InterviewState, StopReason } from '~/lib/interview-machine'
import { fireAndForget } from '~/lib/fire-and-forget'
import { openInterviewStream } from '~/lib/media/devices'
import { SegmentRecorder, detectRecorderSupport } from '~/lib/media/recorder'
import { openTakeStore } from '~/lib/media/takeStore'
import { uploadToSignedUrl } from '~/lib/media/upload'
import {
  answerAtRisk,
  initialInterviewState,
  interviewReducer,
} from '~/lib/interview-machine'
import { cn } from '~/lib/utils'
import { Button } from '~/components/ui/button'
import { Progress } from '~/components/ui/progress'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { CandidateShell } from '~/components/candidate/CandidateShell'
import { AnswerTimer } from '~/components/candidate/AnswerTimer'
import { CameraPreview } from '~/components/candidate/CameraPreview'
import {
  QuestionPrompt,
  QuestionText,
} from '~/components/candidate/QuestionPrompt'
import { Stage } from '~/components/candidate/Stage'
import { RecordingMic } from '~/components/candidate/RecordingMic'
import { candidateErrorKey } from '~/components/candidate/errorState'
import { useCandidateLanguage } from '~/components/candidate/useCandidateLanguage'
import { candidateHead } from '~/components/candidate/screenHead'

type DeviceChoice = { camera?: string; mic?: string }
type EventKind = FunctionArgs<typeof api.interview.logEvent>['kind']

export const Route = createFileRoute('/s/$token/interview')({
  // The devices picked on the check screen; see `openInterviewStream`.
  validateSearch: (search: Record<string, unknown>): DeviceChoice => ({
    camera: typeof search.camera === 'string' ? search.camera : undefined,
    mic: typeof search.mic === 'string' ? search.mic : undefined,
  }),
  component: InterviewRunner,
  head: () => candidateHead('interview'),
})

const detail = (cause: unknown) =>
  cause instanceof Error ? cause.message : 'unknown'

function InterviewRunner() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const devices = Route.useSearch()
  const navigate = useNavigate()

  const [now] = useState(() => Date.now())
  const data = useConvexQuery(api.interview.questions, { token, now })
  const languageReady = useCandidateLanguage(data?.language)
  const start = useConvexMutation(api.interview.start)
  const requestUpload = useConvexAction(api.interview.requestSegmentUpload)
  const markUploaded = useConvexMutation(api.interview.markSegmentUploaded)
  const markVideoUploaded = useConvexMutation(api.interview.markVideoUploaded)
  const markFailed = useConvexMutation(api.interview.markSegmentFailed)
  const logEvent = useConvexMutation(api.interview.logEvent)
  const finish = useConvexMutation(api.interview.finish)
  const promptMedia = useConvexAction(api.interview.promptMediaUrls)

  const [state, dispatch] = useReducer(interviewReducer, initialInterviewState)
  // A boot failure goes to the error boundary, which knows how to say "this
  // interview has closed" as well as "something broke".
  const [fatal, setFatal] = useState<unknown>(null)
  const [elapsed, setElapsed] = useState(0)
  const [online, setOnline] = useState(true)
  const [media, setMedia] = useState<Record<string, string>>({})
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
  // Each answer is also copied to this device as it is recorded, so a reload
  // or a crash does not cost it. Null without IndexedDB; see takeStore.ts.
  const [takes] = useState(() => openTakeStore(token))

  const questions = useMemo(() => data?.questions ?? [], [data])
  const answered = useMemo(
    () => questions.map((question) => question.answered),
    [questions],
  )
  const current = questions.at(state.index)

  /** Candidate-side diagnostics: never allowed to interrupt the interview. */
  const log = useCallback(
    (kind: EventKind, eventDetail?: string) =>
      fireAndForget(
        logEvent({ token, kind, detail: eventDetail }),
        'candidate event log',
      ),
    [logEvent, token],
  )

  /* ── Connectivity. A candidate who goes offline mid-answer must be told,
        while it is happening, not after they press finish. ───────────────── */
  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => {
      setOnline(false)
      log('network_degraded')
    }
    setOnline(navigator.onLine)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [log])

  /* ── Leaving while an answer is on this page and not on the server loses
        it: closing the tab, reloading, or the Back button. The router's
        blocker covers both kinds of exit, and sets `returnValue` on unload,
        which Safari still needs before it will ask. ───────────────────────── */
  const atRisk = answerAtRisk(state.phase)
  useBlocker({
    shouldBlockFn: () => !window.confirm(t('interview:run.leaveConfirm')),
    enableBeforeUnload: atRisk,
    disabled: !atRisk,
  })

  /* ── A phone left untouched locks its screen within a minute — mid-answer,
        and a locked screen reads as leaving the page, which ends the take.
        The browser drops the lock whenever the page is hidden, so it is
        taken again on return. ───────────────────────────────────────────── */
  useEffect(() => {
    if (!('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let released = false
    const acquire = () => {
      if (document.visibilityState !== 'visible') return
      fireAndForget(
        navigator.wakeLock.request('screen').then((sentinel) => {
          if (released) return sentinel.release()
          lock = sentinel
        }),
        'screen wake lock',
      )
    }
    acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', acquire)
      if (lock) fireAndForget(lock.release(), 'screen wake lock release')
    }
  }, [])

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
  // whichever arrives last. Attached once at acquisition, it missed the
  // element — the stream opens while the skeleton is still on screen — and
  // the candidate recorded their whole interview to a black box.
  useEffect(() => {
    if (!preview || !stream) return
    preview.srcObject = stream
    fireAndForget(preview.play(), 'camera preview autoplay')
  }, [preview, stream])

  // Left anyway: the answer is gone, but the journal says it existed, so a
  // missing answer does not read as a skipped one.
  useEffect(
    () => () => {
      if (recorderRef.current) log('recording_abandoned', 'recording')
      else if (recordingRef.current) log('recording_abandoned', 'unsent')
    },
    [log],
  )

  useEffect(() => {
    return () => {
      if (autoStopRef.current) clearTimeout(autoStopRef.current)
      recorderRef.current?.dispose()
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  /* ── Boot, once: mark the session started, sign the question media, open
        the camera — all at once — and start where the server says. The
        client has no resume logic. ─────────────────────────────────────── */
  useEffect(() => {
    if (!data || bootedRef.current) return
    bootedRef.current = true
    const needsMedia = data.questions.some((question) => question.hasMedia)
    // Reported once booted, into a phase that shows it.
    const deviceFailure = openStream().then(
      () => null,
      (cause: unknown) => cause,
    )
    void (async () => {
      try {
        const [, urls] = await Promise.all([
          start({ token }),
          needsMedia ? promptMedia({ token }) : null,
        ])
        if (urls) {
          setMedia(
            Object.fromEntries(urls.questions.map((q) => [q.questionId, q.url])),
          )
        }
      } catch (cause) {
        setFatal(cause)
        return
      }
      dispatch({
        type: 'booted',
        resumeAt: data.nextQuestionIndex,
        total: data.questions.length,
      })
      const failure = await deviceFailure
      if (failure) {
        dispatch({ type: 'deviceFailed', error: candidateErrorKey(failure) })
      }
    })()
  }, [data, start, promptMedia, openStream, token])

  /** Send (or re-send) the recording held for `question`. */
  const send = useCallback(
    async (question: (typeof questions)[number]) => {
      const recording = recordingRef.current
      if (!recording) return
      let segmentId: Id<'segments'> | null = null
      const saved = (videoLost: boolean) => {
        recordingRef.current = null
        fireAndForget(takes.remove(question.orderIndex), 'drop saved take')
        dispatch({ type: 'saved', answered, videoLost })
      }
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
        // An earlier attempt landed and only its response was lost.
        if (slot.status === 'answered') {
          saved(false)
          return
        }
        segmentId = slot.segmentId
        const video = slot.video && recording.video ? recording.video : null
        const total = recording.audio.size + (video?.size ?? 0)
        const progressFrom =
          (offset: number) =>
          ({ loaded, attempt, maxAttempts }: UploadProgress) =>
            dispatch({
              type: 'progress',
              loaded: offset + loaded,
              total,
              attempt,
              maxAttempts,
            })

        await uploadToSignedUrl({
          url: slot.audio.uploadUrl,
          blob: recording.audio,
          contentType: slot.audio.contentType,
          onProgress: progressFrom(0),
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
              onProgress: progressFrom(recording.audio.size),
            })
            await markVideoUploaded({ token, segmentId: slot.segmentId })
          } catch (cause) {
            videoLost = true
            log('upload_failed', `video: ${detail(cause)}`)
          }
        }
        saved(videoLost)
      } catch (cause) {
        dispatch({ type: 'saveFailed', error: candidateErrorKey(cause) })
        // Recorded against the reserved segment as well as the event log, so
        // a recruiter looking at a short interview can see that an answer was
        // attempted and did not arrive, rather than assume it was skipped.
        if (segmentId) {
          fireAndForget(
            markFailed({ token, segmentId, detail: detail(cause) }),
            'segment failure report',
          )
        }
        log('upload_failed', detail(cause))
      }
    },
    [
      requestUpload,
      markUploaded,
      markVideoUploaded,
      markFailed,
      log,
      answered,
      token,
      takes,
    ],
  )

  /**
   * An answer to `question` recorded before a reload or a crash, still on
   * this device: the same attempt, so it is sent rather than recorded again.
   * Takes for answers the server already holds are dropped on the way.
   */
  const recover = useCallback(
    async (question: (typeof questions)[number]) => {
      try {
        await takes.prune(
          (index) => !questions.some((q) => q.orderIndex === index && q.answered),
        )
        const take = await takes.load(question.orderIndex)
        if (!take) return
        recordingRef.current = take
        dispatch({ type: 'recovered' })
        log('recording_recovered')
        await send(question)
      } catch (cause) {
        // Recovery is a bonus: without it the question is simply asked again.
        log('recording_recovered', `failed: ${detail(cause)}`)
      }
    },
    [takes, questions, send, log],
  )

  // Once, on the question the interview resumed at.
  const recoveredRef = useRef(false)
  useEffect(() => {
    if (state.phase === 'loading' || !current || recoveredRef.current) return
    recoveredRef.current = true
    void recover(current)
  }, [state.phase, current, recover])

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
        dispatch({ type: 'stopFailed' })
        log('upload_failed', `recorder: ${detail(cause)}`)
        return
      }
      await send(current)
    },
    [current, send, log],
  )

  /* ── A phone that goes to the background, a headset unplugged, or a
        microphone taken by a phone call or muted by the system keeps
        "recording" an empty track that nobody sees. Stop there, keep what was
        said, and tell the candidate. ─────────────────────────────────────── */
  useEffect(() => {
    if (state.phase !== 'recording') return
    const interrupt = () => void stopAndSave('interrupted')
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') interrupt()
    }
    const tracks = streamRef.current?.getTracks() ?? []
    // `mute` on the microphone only: that is the take going silent.
    const events = (track: MediaStreamTrack) =>
      track.kind === 'audio' ? ['ended', 'mute'] : ['ended']
    document.addEventListener('visibilitychange', onVisibility)
    tracks.forEach((track) =>
      events(track).forEach((e) => track.addEventListener(e, interrupt)),
    )
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      tracks.forEach((track) =>
        events(track).forEach((e) => track.removeEventListener(e, interrupt)),
      )
    }
  }, [state.phase, stopAndSave])

  const beginRecording = async () => {
    if (!current) return
    try {
      const live = await openStream()
      const support = detectRecorderSupport()
      const question = current.orderIndex
      const recorder = new SegmentRecorder(live, support, {
        onTick: ({ elapsedSeconds }) => setElapsed(elapsedSeconds),
        onFailure: () => void stopAndSave('interrupted'),
        onStart: (mimeTypes) =>
          fireAndForget(takes.begin(question, mimeTypes), 'keep take'),
        onChunk: (track, chunk) =>
          fireAndForget(takes.append(question, track, chunk), 'keep take chunk'),
      })
      recorder.start()
      recorderRef.current = recorder
      setElapsed(0)
      dispatch({ type: 'recordingStarted' })
      log('recording_started')

      // Hard stop at the limit the recruiter set. Without silence detection in
      // scope, this and the finish button are the only two ways an answer ends.
      autoStopRef.current = setTimeout(
        () => void stopAndSave('timeUp'),
        current.maxResponseSeconds * 1000,
      )
    } catch (cause) {
      dispatch({ type: 'deviceFailed', error: candidateErrorKey(cause) })
    }
  }

  const retry = () => {
    if (!current) return
    dispatch({ type: 'retry' })
    void send(current)
  }

  const skip = () => {
    recordingRef.current = null
    if (current) fireAndForget(takes.remove(current.orderIndex), 'drop skipped take')
    dispatch({ type: 'skip', answered })
  }

  const finishInterview = async () => {
    dispatch({ type: 'finishRequested' })
    try {
      await finish({ token })
      fireAndForget(takes.prune(), 'drop takes')
      streamRef.current?.getTracks().forEach((track) => track.stop())
      await navigate({ to: '/s/$token/done', params: { token } })
    } catch (cause) {
      dispatch({ type: 'finishFailed', error: candidateErrorKey(cause) })
    }
  }

  if (fatal) throw fatal

  if (data === undefined || !languageReady || state.phase === 'loading') {
    return (
      <CandidateShell width="stage">
        <Skeleton className="mb-4 h-5 w-40" />
        <Skeleton className="min-h-0 flex-1 rounded-xl" />
        <Skeleton className="mx-auto mt-4 h-11 w-48" />
      </CandidateShell>
    )
  }

  const brand = {
    organisationName: data.organisationName,
    logoUrl: data.organisationLogoUrl,
  }
  const notices = (
    <>
      {!online && (
        <Alert>
          <WifiOff className="size-4" />
          <AlertDescription>{t('interview:run.offline')}</AlertDescription>
        </Alert>
      )}
      <LastAnswerNotice state={state} />
    </>
  )

  const inReview =
    state.phase === 'review' ||
    state.phase === 'finishing' ||
    state.phase === 'finishFailed'

  if (inReview) {
    return (
      <CandidateShell {...brand}>
        <LiveStatus state={state} />
        <div className="space-y-6">
          {notices}
          <ReviewScreen
            state={state}
            missing={answered.flatMap((done, index) => (done ? [] : [index]))}
            onRevisit={(index) => dispatch({ type: 'revisit', index })}
            onFinish={() => void finishInterview()}
          />
        </div>
      </CandidateShell>
    )
  }

  if (!current) return <CandidateShell width="stage" {...brand} />

  const recording = state.phase === 'recording'
  // The question has the stage until the candidate starts answering; from
  // then on it is their camera, with the question kept as a caption.
  const asking = state.phase === 'prompt'
  const promptUrl = media[current.questionId]
  const questionMedia = promptUrl
    ? { src: promptUrl, kind: current.mediaKind ?? 'video' }
    : null
  const questionLabel = t('interview:run.progress', {
    index: state.index + 1,
    total: state.total,
  })
  const overlay =
    state.phase === 'saving' ? (
      <Saving state={state} />
    ) : state.phase === 'saveFailed' || state.phase === 'recordingLost' ? (
      <SaveFailed
        lost={state.phase === 'recordingLost'}
        onRetry={retry}
        onRerecord={() => dispatch({ type: 'rerecord' })}
        onSkip={skip}
      />
    ) : null

  return (
    <CandidateShell width="stage" {...brand}>
      <LiveStatus state={state} />

      <div className="mb-4 flex items-center gap-4">
        <p className="text-muted-foreground shrink-0 text-sm tabular-nums">
          {questionLabel}
        </p>
        {/* One segment per question: where this one sits in the whole. */}
        <ol aria-hidden className="flex flex-1 gap-1">
          {answered.map((done, index) => (
            <li
              key={index}
              className={cn(
                'h-1 flex-1 rounded-full',
                done || index === state.index ? 'bg-primary' : 'bg-primary/20',
              )}
            />
          ))}
        </ol>
      </div>

      <div className="mb-4 space-y-3 empty:hidden">
        {notices}
        {state.error && asking && (
          <Alert variant="destructive">
            <CircleAlert className="size-4" />
            <AlertDescription>
              {t(state.error, {
                defaultValue: t('interview:errors.unexpected'),
              })}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Stage
        prompt={
          asking ? (
            <QuestionPrompt
              key={current.questionId}
              content={current.content}
              hint={current.hintText}
              media={questionMedia}
              label={questionLabel}
            />
          ) : null
        }
        self={
          <CameraPreview
            ref={setPreview}
            audioOnly={audioOnly}
            recording={recording}
          />
        }
        caption={
          (!asking || questionMedia?.kind === 'video') && (
            <QuestionText content={current.content} hint={current.hintText} />
          )
        }
        status={
          recording && (
            <AnswerTimer limit={current.maxResponseSeconds} elapsed={elapsed} />
          )
        }
        overlay={overlay}
      />

      {recording && (
        <div className="pt-3">
          <RecordingMic stream={stream} />
        </div>
      )}

      {/* The finish button is the only thing that ends an answer, so it is
          always in the same place and never below the fold. While a save
          covers the stage, its own actions are the way on: the bar keeps its
          room but steps aside. */}
      <div className={cn('flex justify-center pt-4', overlay && 'invisible')}>
        {recording ? (
          <Button size="lg" onClick={() => void stopAndSave('finished')}>
            <Square className="size-4" />
            {t('interview:run.finishAnswer')}
          </Button>
        ) : (
          <Button
            size="lg"
            onClick={() => void beginRecording()}
            disabled={!asking}
          >
            <Play className="size-4" />
            {t('interview:run.startAnswer')}
          </Button>
        )}
      </div>
    </CandidateShell>
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
const STOP_NOTICES: Partial<Record<StopReason, string>> = {
  timeUp: 'run.timeUp',
  interrupted: 'run.interrupted',
  recovered: 'run.recovered',
}

function LastAnswerNotice({ state }: { state: InterviewState }) {
  const { t } = useTranslation('interview')
  if (state.phase !== 'prompt' && state.phase !== 'review') return null
  const key = state.videoLost
    ? 'run.videoLost'
    : state.stopReason && STOP_NOTICES[state.stopReason]
  if (!key) return null
  const message = t(key)
  return (
    <Alert>
      <CircleAlert className="size-4" />
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  )
}

function Saving({ state }: { state: InterviewState }) {
  const { t } = useTranslation('interview')
  const { progress } = state
  const percent = progress?.percent ?? 0
  return (
    <Alert>
      <AlertTitle>
        {progress && progress.attempt > 1
          ? t('run.retrying', {
              attempt: progress.attempt,
              max: progress.maxAttempts,
            })
          : t('run.sending')}
      </AlertTitle>
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
  lost,
  onRetry,
  onRerecord,
  onSkip,
}: {
  lost: boolean
  onRetry: () => void
  onRerecord: () => void
  onSkip: () => void
}) {
  const { t } = useTranslation('interview')
  const copy = lost ? 'run.recordingLost' : 'run.sendFailed'
  return (
    <Alert variant="destructive">
      <CircleAlert className="size-4" />
      <AlertTitle>{t(`${copy}.title`)}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{t(`${copy}.body`)}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="lg" onClick={lost ? onRerecord : onRetry}>
            {lost ? t('run.recordingLost.rerecord') : t('run.sendFailed.retry')}
          </Button>
          <Button size="lg" variant="outline" onClick={onSkip}>
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
                    {t(state.error, {
                      defaultValue: t('interview:errors.unexpected'),
                    })}
                  </AlertDescription>
        </Alert>
      )}

      <Button size="lg" onClick={onFinish} disabled={state.phase === 'finishing'}>
        {state.phase === 'finishing'
          ? t('run.finishing')
          : t('run.finishInterview')}
      </Button>
    </div>
  )
}
