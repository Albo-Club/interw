import { useCallback, useEffect, useRef, useState } from 'react'
import { useConvexAction, useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Circle, Mic, Square, Trash2, Video } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import type { Id } from '../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { SingleRecorder, detectRecorderSupport } from '~/lib/media/recorder'
import { uploadToSignedUrl } from '~/lib/media/upload'
import { Button } from '~/components/ui/button'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { cn } from '~/lib/utils'

type Phase = 'idle' | 'arming' | 'recording' | 'uploading' | 'error'

/**
 * Record a question prompt in the browser and upload it straight to object
 * storage.
 *
 * The bytes never pass through Convex: an action mints a one-shot presigned
 * PUT and the browser writes to the bucket. Convex HTTP responses cap at
 * 20 MB and action returns at 16 MiB, so routing media through them would
 * put a ceiling on a two-minute video.
 */
export function MediaRecorderField({
  questionId,
  hasMedia,
  onChanged,
  disabled,
}: {
  questionId: Id<'questions'>
  hasMedia: boolean
  onChanged: () => void
  disabled?: boolean
}) {
  const { t } = useTranslation(['projects', 'common'])
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const recorderRef = useRef<SingleRecorder | null>(null)

  const requestUpload = useConvexAction(api.media.requestQuestionUpload)
  const attach = useConvexAction(api.media.attachQuestionMedia)
  const clear = useConvexMutation(api.media.clearQuestionMedia)

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
      if (!support.video && !support.audio) {
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
      setError(
        cause instanceof Error && cause.name === 'NotAllowedError'
          ? t('projects:questions.media.permissionDenied')
          : t('projects:questions.media.uploadFailed'),
      )
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

      const slot = await requestUpload({
        questionId,
        mimeType,
        contentLength: blob.size,
      })
      await uploadToSignedUrl({
        url: slot.uploadUrl,
        blob,
        contentType: slot.contentType,
      })
      await attach({
        questionId,
        key: slot.key,
        mediaKind: mimeType.startsWith('video/') ? 'video' : 'audio',
      })
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
      await clear({ questionId })
      onChanged()
    } catch (cause) {
      const { key, fallbackKey } = errorMessageKey(cause, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <div className="space-y-3">
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
          className="size-full object-cover"
        />
        {phase === 'recording' && (
          <div className="bg-destructive text-destructive-foreground absolute top-2 left-2 flex items-center gap-1.5 rounded-full px-2 py-1 text-xs font-medium">
            <Circle className="size-2 fill-current" aria-hidden />
            <span className="tabular-nums">{formatElapsed(elapsed)}</span>
          </div>
        )}
        {phase !== 'recording' && (
          <div className="text-muted-foreground absolute inset-0 flex items-center justify-center gap-2 text-sm">
            {hasMedia ? (
              <>
                <Video className="size-4" />
                {t('projects:questions.media.ready')}
              </>
            ) : (
              <>
                <Mic className="size-4" />
                {t('projects:questions.media.none')}
              </>
            )}
          </div>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap gap-2">
        {phase === 'recording' ? (
          <Button type="button" onClick={() => void stopAndUpload()}>
            <Square className="size-4" />
            {t('projects:questions.media.stop')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => void start()}
            disabled={disabled || phase === 'arming' || phase === 'uploading'}
          >
            <Circle className="size-4" />
            {hasMedia
              ? t('projects:questions.media.rerecord')
              : t('projects:questions.media.record')}
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
            {t('projects:questions.media.remove')}
          </Button>
        )}
        {phase === 'uploading' && (
          <span className="text-muted-foreground self-center text-sm">
            {t('projects:questions.media.uploading')}
          </span>
        )}
      </div>
    </div>
  )
}

function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}
