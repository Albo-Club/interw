import { useTranslation } from 'react-i18next'

import { Badge } from '~/components/ui/badge'
import { cn } from '~/lib/utils'

export type SessionStatus =
  | 'pending'
  | 'in_progress'
  | 'completed'
  | 'cancelled'
  | 'expired'

export type RecruiterDecision =
  | 'rejected'
  | 'maybe'
  | 'shortlisted'
  | 'hired'
  | null

/** Where a candidate is in the process. Shape carries it as much as words. */
export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  const { t } = useTranslation('candidates')
  const styles: Record<SessionStatus, string> = {
    pending: 'border-border text-muted-foreground',
    in_progress: 'border-info/40 text-info-strong',
    completed: 'border-success/40 text-success-strong',
    cancelled: 'border-border text-muted-foreground line-through',
    expired: 'border-border text-muted-foreground',
  }
  return (
    <Badge variant="outline" className={styles[status]}>
      {t(`status.${status}`)}
    </Badge>
  )
}

/**
 * The recruiter's own call, deliberately styled apart from the AI score: one
 * is a decision, the other is a reading aid, and they must never be mistaken
 * for one another at a glance.
 */
export function DecisionBadge({ decision }: { decision: RecruiterDecision }) {
  const { t } = useTranslation('candidates')
  if (!decision) {
    return (
      <span className="text-muted-foreground text-sm">
        {t('decision.none')}
      </span>
    )
  }
  const styles: Record<NonNullable<RecruiterDecision>, string> = {
    rejected: 'bg-destructive-subtle text-destructive-strong',
    maybe: 'bg-warning-subtle text-warning-strong',
    shortlisted: 'bg-info-subtle text-info-strong',
    hired: 'bg-success-subtle text-success-strong',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium',
        styles[decision],
      )}
    >
      {t(`decision.${decision}`)}
    </span>
  )
}

/**
 * Score colour follows the thresholds the product has always used: 70 and
 * above reads as good, 45 and above as worth a look, below that as weak.
 */
export function ScoreBadge({ score }: { score: number }) {
  const tone =
    score >= 70
      ? 'text-success-strong'
      : score >= 45
        ? 'text-warning-strong'
        : 'text-destructive-strong'
  return (
    <span className={cn('font-semibold tabular-nums', tone)}>{score}</span>
  )
}
