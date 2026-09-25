import { Loader2, Play } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { downloadMedia } from './download'
import { Button } from '~/components/ui/button'
import { fireAndForget } from '~/lib/fire-and-forget'
import { cn } from '~/lib/utils'

export type PlayableSegment = {
  segmentId: string
  url: string
  kind: string
}

/**
 * The player every citation points at.
 *
 * Seeking is driven by a `{ segmentId, seconds, nonce }` cue rather than by a
 * plain timestamp: clicking the same quote twice has to replay it, and two
 * quotes at the same second in different answers have to switch source. The
 * nonce is what makes a repeat click do something.
 */
export type SeekCue = {
  segmentId: string
  seconds: number
  nonce: number
} | null

/** The active answer's local copy — every state visible, none silent. */
type Download = { segmentId: string } & (
  | { phase: 'loading'; percent: number | null }
  | { phase: 'done'; objectUrl: string }
  | { phase: 'failed' }
)

export function AnswerPlayer({
  segments,
  cue,
  activeSegmentId,
  onSelect,
  questionLabels,
  answerLengths,
}: {
  segments: Array<PlayableSegment>
  cue: SeekCue
  activeSegmentId: string | null
  onSelect: (segmentId: string) => void
  questionLabels: Record<string, string>
  /** Seconds, from the report: a MediaRecorder file does not know its own. */
  answerLengths: Record<string, number | null>
}) {
  const { t } = useTranslation('report')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [download, setDownload] = useState<Download | null>(null)
  /** A seek that landed but whose autoplay the browser refused. */
  const [playAt, setPlayAt] = useState<number | null>(null)
  // `segments[0]` is only defined when the list is non-empty, and tsconfig has
  // no noUncheckedIndexedAccess — so say so explicitly rather than let the
  // optional chains below read as dead code.
  const current: PlayableSegment | undefined =
    segments.find((segment) => segment.segmentId === activeSegmentId) ??
    (segments.length > 0 ? segments[0] : undefined)
  const segmentId = current?.segmentId
  const url = current?.url
  const status = download?.segmentId === segmentId ? download : null
  const objectUrl = status?.phase === 'done' ? status.objectUrl : undefined

  // The whole answer, as soon as it is shown — see `downloadMedia`.
  useEffect(() => {
    if (!segmentId || !url) return
    const controller = new AbortController()
    let local: string | null = null
    setPlayAt(null)
    setDownload({ segmentId, phase: 'loading', percent: null })
    downloadMedia(
      url,
      (percent) => setDownload({ segmentId, phase: 'loading', percent }),
      controller.signal,
    ).then(
      (blob) => {
        if (controller.signal.aborted) return
        local = URL.createObjectURL(blob)
        setDownload({ segmentId, phase: 'done', objectUrl: local })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        console.warn('[interw] answer download failed', error)
        setDownload({ segmentId, phase: 'failed' })
      },
    )
    return () => {
      controller.abort()
      if (local) URL.revokeObjectURL(local)
    }
  }, [segmentId, url])

  // A cue that arrives mid-download waits here for the local copy.
  useEffect(() => {
    const video = videoRef.current
    if (!cue || !video || !objectUrl || cue.segmentId !== segmentId) return
    const seek = () => {
      video.currentTime = cue.seconds
      video.play().then(
        () => setPlayAt(null),
        // Autoplay refused (iOS, once the wait outlived the click): offer a
        // play button rather than leave a click that did nothing.
        () => setPlayAt(cue.seconds),
      )
    }
    // Seeking before metadata is loaded is silently ignored by every browser.
    if (video.readyState >= 1) {
      seek()
      return
    }
    video.addEventListener('loadedmetadata', seek, { once: true })
    return () => video.removeEventListener('loadedmetadata', seek)
  }, [cue, segmentId, objectUrl])

  if (segments.length === 0) return null

  return (
    <div className="space-y-3">
      <video
        ref={videoRef}
        key={segmentId}
        src={objectUrl}
        controls
        playsInline
        className="bg-muted aspect-video w-full rounded-lg"
      />
      <div aria-live="polite" className="text-muted-foreground text-sm">
        {status?.phase === 'loading' && (
          <span className="inline-flex items-center gap-2">
            <Loader2
              aria-hidden
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            {status.percent === null
              ? t('player.loading')
              : t('player.loadingPercent', { percent: status.percent })}
          </span>
        )}
        {status?.phase === 'failed' && (
          <span className="text-destructive">{t('player.failed')}</span>
        )}
        {playAt !== null && (
          <Button
            size="sm"
            onClick={() => {
              const video = videoRef.current
              // A refusal leaves this button in place, which is the signal.
              if (video) {
                fireAndForget(
                  video.play().then(() => setPlayAt(null)),
                  'report playback',
                )
              }
            }}
          >
            <Play aria-hidden />
            {t('player.playAt', { time: formatTimecode(playAt) })}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {segments.map((segment, index) => {
          const length = answerLengths[segment.segmentId]
          return (
            <button
              key={segment.segmentId}
              type="button"
              onClick={() => onSelect(segment.segmentId)}
              aria-current={segment.segmentId === segmentId}
              className={cn(
                'focus-visible:ring-ring rounded-md border px-3 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none',
                segment.segmentId === segmentId
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'text-muted-foreground hover:bg-accent',
              )}
            >
              {questionLabels[segment.segmentId] ??
                t('answers.question', { index: index + 1 })}
              {length != null && (
                <span className="text-muted-foreground tabular-nums">
                  {' · '}
                  {formatTimecode(length)}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** `m:ss`, for a citation label. */
export function formatTimecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
