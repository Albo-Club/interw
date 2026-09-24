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
 */
export function CameraPreview({
  ref,
  audioOnly,
  recording = false,
  countdown = null,
  children,
}: {
  ref: Ref<HTMLVideoElement>
  audioOnly: boolean
  recording?: boolean
  /** Seconds left, once the countdown is showing. */
  countdown?: number | null
  /** Overlaid on the preview, for a status line. */
  children?: ReactNode
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
      {children}
      {recording && (
        <div className="bg-destructive text-destructive-foreground absolute top-3 left-3 flex items-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium">
          {/* The dot pulses to say "live". It stops under
              prefers-reduced-motion — a candidate is looking at this screen
              for minutes, and the badge still reads as recording without it. */}
          <span className="size-2 animate-pulse rounded-full bg-current motion-reduce:animate-none" />
          {t('run.recording')}
        </div>
      )}
      {countdown !== null && (
        <div className="bg-warning text-warning-foreground absolute top-3 right-3 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums">
          {t('run.timeLeft', { seconds: countdown })}
        </div>
      )}
    </div>
  )
}
