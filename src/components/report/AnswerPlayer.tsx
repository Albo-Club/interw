import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

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

export function AnswerPlayer({
  segments,
  cue,
  activeSegmentId,
  onSelect,
  questionLabels,
}: {
  segments: Array<PlayableSegment>
  cue: SeekCue
  activeSegmentId: string | null
  onSelect: (segmentId: string) => void
  questionLabels: Record<string, string>
}) {
  const { t } = useTranslation('report')
  const videoRef = useRef<HTMLVideoElement | null>(null)
  // `segments[0]` is only defined when the list is non-empty, and tsconfig has
  // no noUncheckedIndexedAccess — so say so explicitly rather than let the
  // optional chains below read as dead code.
  const current: PlayableSegment | undefined =
    segments.find((segment) => segment.segmentId === activeSegmentId) ??
    (segments.length > 0 ? segments[0] : undefined)

  useEffect(() => {
    if (!cue || !videoRef.current) return
    if (cue.segmentId !== current?.segmentId) return
    const video = videoRef.current
    const seek = () => {
      video.currentTime = cue.seconds
      void video.play().catch(() => undefined)
    }
    // Seeking before metadata is loaded is silently ignored by every browser,
    // which is how "jump to quote" turns into "plays from the beginning".
    if (video.readyState >= 1) seek()
    else video.addEventListener('loadedmetadata', seek, { once: true })
  }, [cue, current?.segmentId])

  if (segments.length === 0) return null

  return (
    <div className="space-y-3">
      <video
        ref={videoRef}
        key={current?.segmentId}
        src={current?.url}
        controls
        playsInline
        className="bg-muted aspect-video w-full rounded-lg"
      />
      <div className="flex flex-wrap gap-2">
        {segments.map((segment, index) => (
          <button
            key={segment.segmentId}
            type="button"
            onClick={() => onSelect(segment.segmentId)}
            aria-current={segment.segmentId === current?.segmentId}
            className={cn(
              'focus-visible:ring-ring rounded-md border px-3 py-1.5 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none',
              segment.segmentId === current?.segmentId
                ? 'border-primary bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {questionLabels[segment.segmentId] ??
              t('answers.question', { index: index + 1 })}
          </button>
        ))}
      </div>
    </div>
  )
}

/** `m:ss`, for a citation label. */
export function formatTimecode(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}
