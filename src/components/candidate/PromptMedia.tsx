import { cn } from '~/lib/utils'

/**
 * A recruiter's recording, played back: to the candidate before a question,
 * and to the recruiter who recorded it. An audio prompt gets a player bar —
 * in a `<video>` it rendered as an empty black 16:9 box with controls.
 */
export function PromptMedia({
  src,
  kind,
  label,
  className,
}: {
  src: string
  kind: 'audio' | 'video'
  /** The accessible name: what this recording is. */
  label: string
  className?: string
}) {
  return kind === 'audio' ? (
    <audio
      src={src}
      controls
      preload="metadata"
      aria-label={label}
      className={cn('w-full', className)}
    />
  ) : (
    <video
      src={src}
      controls
      playsInline
      preload="metadata"
      aria-label={label}
      className={cn('bg-muted aspect-video w-full rounded-md', className)}
    />
  )
}
