import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvexAction, useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Circle, Mic, Square, Trash2, Video } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { PromptMedia } from '~/components/candidate/PromptMedia'
import { SingleRecorder, detectRecorderSupport } from '~/lib/media/recorder'
import { uploadToSignedUrl } from '~/lib/media/upload'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { cn } from '~/lib/utils'

type Phase = 'idle' | 'arming' | 'recording' | 'uploading' | 'error'

/** What is being recorded: a question's prompt, or the role's intro. */
export type RecordingTarget =
  | { kind: 'question'; questionId: Id<'questions'> }
  | { kind: 'intro'; projectId: Id<'projects'> }

/**
 * Record a question prompt or the role's intro in the browser, upload it
 * straight to object storage, and play it back once it is there.
 *
 * The bytes never pass through Convex: an action mints a one-shot presigned
 * PUT and the browser writes to the bucket. Convex HTTP responses cap at
 * 20 MB and action returns at 16 MiB, so routing media through them would
 * put a ceiling on a two-minute video.
 *
 * The intro is filmed, never audio alone: without a camera the take is
 * refused rather than saved as something the role does not offer.
 */
export function MediaRecorderField({
  target,
  hasMedia,
  playback,
  onChanged,
  disabled,
}: {
  target: RecordingTarget
  hasMedia: boolean
  /** The signed URL of what is recorded, once it has been fetched. */
  playback: { url: string; kind: 'audio' | 'video' } | null
  onChanged: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation(['projects', 'common'])
  const videoOnly = target.kind === 'intro'
  const copy = videoOnly
    ? 'projects:basics.intro.media'
    : 'projects:questions.media'
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<SingleRecorder | null>(null)

  const requestQuestionUpload = useConvexAction(api.media.requestQuestionUpload)
  const attachQuestion = useConvexAction(api.media.attachQuestionMedia)
  const clearQuestion = useConvexMutation(api.media.clearQuestionMedia)
  const requestIntroUpload = useConvexAction(api.media.requestIntroUpload)
  const attachIntro = useConvexAction(api.media.attachIntroMedia)
  const clearIntro = useConvexMutation(api.media.clearIntroMedia)

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  // A camera left running after the recruiter navigates away is both a
  // privacy surprise and a dead battery.
  useEffect(() => {
    return () => {
      recorderRef.current?.dispose()
      releaseStream()
    }
  }, [releaseStream])

  const start = async () => {
    setError(null)
    setPhase('arming')
    try {
      const support = detectRecorderSupport()
      if (!support.video && (videoOnly || !support.audio)) {
        throw new Error('unsupported_browser')
      }
      const wantsVideo = support.video !== null
      const stream = await navigator.mediaDevices.getUserMedia({
        video: wantsVideo ? { width: 1280, height: 720 } : false,
        audio: true,
      })
      streamRef.current = stream
      if (videoRef.current && wantsVideo) {
        videoRef.current.srcObject = stream
        // Autoplay rejection is expected, not an error: browsers refuse it
      // without a user gesture, and the preview still renders the stream.
      await videoRef.current.play().catch(() => undefined)
      }
      const mimeType = support.video ?? support.audio
      if (!mimeType) throw new Error('unsupported_browser')

      const recorder = new SingleRecorder(stream, mimeType, ({ elapsedSeconds }) =>
        setElapsed(elapsedSeconds),
      )
      recorderRef.current = recorder
      recorder.start()
      setElapsed(0)
      setPhase('recording')
    } catch (cause) {
      setPhase('error')
      setError(t(`${copy}.${startFailureKey(cause)}`))
      releaseStream()
    }
  }

  const stopAndUpload = async () => {
    const recorder = recorderRef.current
    if (!recorder) return
    setPhase('uploading')
    try {
      const { blob, mimeType } = await recorder.stop()
      releaseStream()
      recorderRef.current = null

      const request = { mimeType, contentLength: blob.size }
      const slot =
        target.kind === 'intro'
          ? await requestIntroUpload({ projectId: target.projectId, ...request })
          : await requestQuestionUpload({
              questionId: target.questionId,
              ...request,
            })
      await uploadToSignedUrl({
        url: slot.uploadUrl,
        blob,
        contentType: slot.contentType,
      })
      await (target.kind === 'intro'
        ? attachIntro({ projectId: target.projectId, key: slot.key })
        : attachQuestion({ questionId: target.questionId, key: slot.key }))
      setPhase('idle')
      onChanged()
    } catch (cause) {
      setPhase('error')
      const { key, fallbackKey } = errorMessageKey(cause, 'projects')
      setError(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  const remove = async () => {
    try {
      await (target.kind === 'intro'
        ? clearIntro({ projectId: target.projectId })
        : clearQuestion({ questionId: target.questionId }))
      onChanged()
    } catch (cause) {
      const { key, fallbackKey } = errorMessageKey(cause, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  const busy = phase === 'arming' || phase === 'recording'
  const player = hasMedia && !busy ? playback : null

  return (
    <div className="space-y-3">
      {player ? (
        <PromptMedia
          key={player.url}
          src={player.url}
          kind={player.kind}
          label={t(`${copy}.ready`)}
        />
      ) : (
        <div
          className={cn(
            'bg-muted relative aspect-video w-full overflow-hidden rounded-md',
            phase === 'recording' ? 'ring-destructive ring-2' : '',
          )}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            aria-hidden
            className="size-full object-cover"
          />
          {phase === 'recording' && (
            <div className="bg-destructive text-destructive-foreground absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium">
              <Circle className="size-2 fill-current" aria-hidden />
              <span className="tabular-nums">{formatElapsed(elapsed)}</span>
            </div>
          )}
          {!busy && (
            <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 px-4 text-center text-sm">
              {hasMedia || videoOnly ? (
                <Video className="size-4 shrink-0" aria-hidden />
              ) : (
                <Mic className="size-4 shrink-0" aria-hidden />
              )}
              {t(hasMedia ? `${copy}.ready` : `${copy}.none`)}
            </div>
          )}
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        {phase === 'recording' ? (
          <Button type="button" onClick={() => void stopAndUpload()}>
            <Square className="size-4" />
            {t(`${copy}.stop`)}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => void start()}
            disabled={disabled || phase === 'arming' || phase === 'uploading'}
          >
            <Circle className="size-4" />
            {hasMedia ? t(`${copy}.rerecord`) : t(`${copy}.record`)}
          </Button>
        )}
        {hasMedia && phase !== 'recording' && (
          <Button
            type="button"
            variant="ghost"
            onClick={() => void remove()}
            disabled={disabled}
          >
            <Trash2 className="size-4" />
            {t(`${copy}.remove`)}
          </Button>
        )}
        {phase === 'uploading' && (
          <span
            role="status"
            className="text-muted-foreground self-center text-sm"
          >
            {t(`${copy}.uploading`)}
          </span>
        )}
      </div>
    </div>
  )
}

/** Why the camera did not start, as the copy key that says what to do. */
function startFailureKey(cause: unknown): string {
  if (!(cause instanceof Error)) return 'uploadFailed'
  if (cause.name === 'NotAllowedError') return 'permissionDenied'
  if (cause.name === 'NotFoundError') return 'noCamera'
  if (cause.message === 'unsupported_browser') return 'unsupported'
  return 'uploadFailed'
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
