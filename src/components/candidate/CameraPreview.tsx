import { useTranslation } from 'react-i18next'
import { Mic } from 'lucide-react'
import type { ReactNode, Ref } from 'react'

import { cn } from '~/lib/utils'

/**
 * The candidate's view of themselves, on the check screen and while they
 * answer — the only feedback they have on their framing.
 *
 * Portrait on a phone, landscape from `sm` up: a phone held upright gives a
 * portrait stream, and a 16:9 box cropped the candidate to a strip of face.
 * With `fill`, the box is whatever the interview stage makes it instead.
 */
export function CameraPreview({
  ref,
  audioOnly,
  fill = false,
  recording = false,
  children,
}: {
  ref: Ref<HTMLVideoElement>
  audioOnly: boolean
  /** Fill the parent instead of keeping its own aspect ratio. */
  fill?: boolean
  recording?: boolean
  /** Overlaid on the preview, for a status line. */
  children?: ReactNode
}) {
  const { t } = useTranslation('interview')
  return (
    <div
      className={cn(
        '@container relative overflow-hidden',
        fill
          ? 'bg-stage size-full'
          : 'bg-muted aspect-[3/4] w-full rounded-lg sm:aspect-video',
      )}
    >
      {audioOnly ? (
        <div
          className={cn(
            'flex size-full flex-col items-center justify-center gap-3 p-6 text-center text-sm',
            fill ? 'text-stage-foreground/80' : 'text-muted-foreground',
          )}
        >
          <Mic className="size-8" />
          {/* In the stage's thumbnail there is room for the icon only. */}
          <p className="hidden max-w-sm leading-relaxed @xs:block">
            {t('run.audioOnly')}
          </p>
        </div>
      ) : (
        <video
          ref={ref}
          muted
          playsInline
          className="size-full scale-x-[-1] object-cover"
        />
      )}
      {children}
      {/* Drawn over the video: an inset ring on the box itself would sit
          under it. */}
      {recording && (
        <div className="ring-destructive pointer-events-none absolute inset-0 rounded-[inherit] ring-2 ring-inset" />
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
    </div>
  )
}
