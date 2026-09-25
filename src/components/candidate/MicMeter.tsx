import { useTranslation } from 'react-i18next'

import type { MicVerdict } from '~/lib/media/devices'
import { cn } from '~/lib/utils'

/** How loud the microphone is, coloured by what that level means. */
export function MicMeter({ level, verdict }: { level: number; verdict: MicVerdict }) {
  const { t } = useTranslation('interview')
  const percent = Math.min(100, Math.round(level * 320))
  return (
    <div
      className="bg-muted h-3 w-full overflow-hidden rounded-full"
      role="meter"
      aria-label={t('device.micLabel')}
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className={cn(
          'h-full transition-[width] duration-75 motion-reduce:transition-none',
          verdict === 'good'
            ? 'bg-success'
            : verdict === 'quiet'
              ? 'bg-warning'
              : 'bg-muted-foreground/40',
        )}
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}
