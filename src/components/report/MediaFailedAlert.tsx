import { useTranslation } from 'react-i18next'
import { RotateCw } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'

/** The recordings did not load: say so, and offer the way out. A silent
 *  player reads as "there is no evidence", which is worse than an error. */
export function MediaFailedAlert({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation('report')
  return (
    <Alert variant="destructive" role="alert">
      <AlertTitle>{t('media.failedTitle')}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{t('media.failedBody')}</p>
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCw className="size-4" aria-hidden />
          {t('media.retry')}
        </Button>
      </AlertDescription>
    </Alert>
  )
}
