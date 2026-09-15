import { useTranslation } from 'react-i18next'
import { Info } from 'lucide-react'

import { cn } from '~/lib/utils'

/**
 * Permanent, not dismissible.
 *
 * This is a hiring decision: telling the reader that the score and the
 * recommendation are machine-produced, and that the decision is theirs, is a
 * regulatory obligation before it is a courtesy. It is styled to be read, not
 * to be skipped — but not so loud that it competes with the verdict.
 */
export function AiDisclaimer({
  variant = 'inline',
  className,
}: {
  variant?: 'inline' | 'full'
  className?: string
}) {
  const { t } = useTranslation('report')
  return (
    <p
      className={cn(
        'text-muted-foreground flex items-start gap-2 text-xs leading-relaxed',
        className,
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
      <span>
        {variant === 'full'
          ? t('disclaimer.long')
          : t('disclaimer.short')}
      </span>
    </p>
  )
}
