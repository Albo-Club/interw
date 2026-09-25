import { useTranslation } from 'react-i18next'

import { cn, formatTimecode } from '~/lib/utils'

/** The timer turns to a warning for the last 30 seconds. */
const WARNING_SECONDS = 30

/**
 * How long the answer being recorded has left: `m:ss` in the stage's corner
 * and a bar along its bottom edge, both visible from the first second —
 * long before the warning — so the time left reads at a glance.
 */
export function AnswerTimer({
  limit,
  elapsed,
}: {
  limit: number
  elapsed: number
}) {
  const { t } = useTranslation('interview')
  const left = Math.max(0, limit - elapsed)
  const urgent = left <= WARNING_SECONDS
  return (
    <>
      <div
        role="timer"
        aria-label={t('run.timeLeft', { seconds: left })}
        className={cn(
          'absolute top-3 right-3 rounded-full px-3 py-1.5 text-sm font-semibold tabular-nums',
          urgent
            ? 'bg-warning text-warning-foreground'
            : 'bg-stage/70 text-stage-foreground',
        )}
      >
        {formatTimecode(left)}
      </div>
      <div className="bg-stage-foreground/20 absolute inset-x-0 bottom-0 h-1">
        <div
          className={cn(
            'h-full origin-left transition-transform duration-1000 ease-linear motion-reduce:transition-none',
            urgent ? 'bg-warning' : 'bg-destructive',
          )}
          style={{ transform: `scaleX(${Math.min(1, elapsed / limit)})` }}
        />
      </div>
    </>
  )
}
