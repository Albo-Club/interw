import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'

import { fireAndForget } from '~/lib/fire-and-forget'
import { cn } from '~/lib/utils'

export type PlayableSegment = {
  segmentId: string
  url: string
  /** Decides the element: an audio-only answer in a `<video>` is a black box. */
  kind: 'audio' | 'video'
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
  onError,
}: {
  segments: Array<PlayableSegment>
  cue: SeekCue
  activeSegmentId: string | null
  onSelect: (segmentId: string) => void
  questionLabels: Record<string, string>
  /** The source failed to load — typically an expired signed URL. */
  onError: () => void
}) {
  const { t } = useTranslation('report')
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  // One ref for either element; a callback because a `RefObject` is typed to
  // one of them.
  const attachMedia = (element: HTMLMediaElement | null) => {
    mediaRef.current = element
  }
  // `segments[0]` is only defined when the list is non-empty, and tsconfig has
  // no noUncheckedIndexedAccess — so say so explicitly rather than let the
  // optional chains below read as dead code.
  const current: PlayableSegment | undefined =
    segments.find((segment) => segment.segmentId === activeSegmentId) ??
    (segments.length > 0 ? segments[0] : undefined)

  // `src` is set here rather than as a prop so a re-signed URL for the same
  // answer can pick up where the recruiter was: swapping the attribute resets
  // the element to 0:00, paused. A different answer mounts a fresh element
  // (`key` below), which has no position to keep.
  useEffect(() => {
    const video = mediaRef.current
    const url = current?.url
    if (!video || !url || video.getAttribute('src') === url) return
    const resumeAt = video.currentTime
    const wasPlaying = !video.paused
    video.src = url
    if (resumeAt === 0) return
    video.addEventListener(
      'loadedmetadata',
      () => {
        video.currentTime = resumeAt
        if (wasPlaying) fireAndForget(video.play(), 'resume playback')
      },
      { once: true },
    )
  }, [current?.url])

  useEffect(() => {
    if (!cue || !mediaRef.current) return
    if (cue.segmentId !== current?.segmentId) return
    const video = mediaRef.current
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
      {current?.kind === 'audio' ? (
        <audio
          ref={attachMedia}
          key={current.segmentId}
          onError={onError}
          controls
          className="w-full"
        />
      ) : (
        <video
          ref={attachMedia}
          key={current?.segmentId}
          onError={onError}
          controls
          playsInline
          className="bg-muted aspect-video w-full rounded-lg"
        />
      )}
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
