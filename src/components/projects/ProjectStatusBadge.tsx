import { useTranslation } from 'react-i18next'

import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'

export type ProjectStatus = 'draft' | 'active' | 'archived'

/**
 * Status as shape as well as text: a recruiter scanning a list of thirty roles
 * should see which ones are live without reading a word.
 */
export function ProjectStatusBadge({
  status,
  expired,
  className,
}: {
  status: ProjectStatus
  expired?: boolean
  className?: string
}) {
  const { t } = useTranslation('projects')
  if (expired && status === 'active') {
    return (
      <Badge
        variant="outline"
        className={cn('border-warning/40 text-warning-strong', className)}
      >
        {t('status.expired')}
      </Badge>
    )
  }
  const styles: Record<ProjectStatus, string> = {
    draft: 'border-border text-muted-foreground',
    active: 'border-success/40 text-success-strong',
    archived: 'border-border text-muted-foreground opacity-70',
  }
  return (
    <Badge variant="outline" className={cn(styles[status], className)}>
      {t(`status.${status}`)}
    </Badge>
  )
}
