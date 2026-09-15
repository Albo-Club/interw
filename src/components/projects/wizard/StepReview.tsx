import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleAlert } from 'lucide-react'

import type { WizardCriterion, WizardProject, WizardQuestion } from './types'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'

/**
 * The last screen before publishing: what is ready, and what is not.
 *
 * A "missing" item is a specific instruction, never a generic "incomplete" —
 * the recruiter should never have to hunt for which step is blocking them.
 */
export function StepReview({
  project,
  questions,
  criteria,
}: {
  project: WizardProject
  questions: Array<WizardQuestion>
  criteria: Array<WizardCriterion>
}) {
  const { t } = useTranslation(['projects', 'common'])

  const missing: Array<string> = []
  if (questions.length === 0) missing.push(t('projects:review.missing.questions'))
  if (criteria.length === 0) missing.push(t('projects:review.missing.criteria'))
  const ready = missing.length === 0

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('projects:review.title')}</h2>
        <p className="text-muted-foreground text-sm">
          {t('projects:review.subtitle')}
        </p>
      </div>

      {ready ? (
        <Alert className="border-success/40 bg-success-subtle">
          <CheckCircle2 className="text-success-strong size-4" />
          <AlertTitle>{t('projects:review.readyTitle')}</AlertTitle>
          <AlertDescription>{t('projects:review.readyBody')}</AlertDescription>
        </Alert>
      ) : (
        <Alert className="border-warning/40 bg-warning-subtle">
          <CircleAlert className="text-warning-strong size-4" />
          <AlertTitle>{t('projects:review.blocked')}</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {missing.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <dl className="divide-border grid divide-y rounded-md border text-sm">
        <Row
          label={t('projects:new.fields.jobTitle')}
          value={project.jobTitle ?? '—'}
        />
        <Row
          label={t('projects:detail.stats.duration')}
          value={t('projects:detail.stats.durationValue', {
            count: project.maxDurationMinutes,
          })}
        />
        <Row
          label={t('projects:detail.stats.questions')}
          value={String(questions.length)}
        />
        <Row
          label={t('projects:detail.stats.criteria')}
          value={String(criteria.length)}
        />
        <Row
          label={t('projects:detail.stats.expiry')}
          value={
            project.expiresAt
              ? new Date(project.expiresAt).toLocaleDateString()
              : t('projects:detail.stats.noExpiry')
          }
        />
      </dl>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-medium tabular-nums">{value}</dd>
    </div>
  )
}
