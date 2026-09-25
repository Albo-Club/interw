import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, CircleAlert, Users } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { maxInterviewMinutes } from '../../../../convex/lib/interviewDuration'
import { stepOfBlocker } from './steps'
import type { PublishBlocker } from '../../../../convex/lib/publishReadiness'
import type { WizardStep } from './steps'
import type { Id } from '../../../../convex/_generated/dataModel'
import type { WizardCriterion, WizardProject, WizardQuestion } from './types'
import { errorMessageKey } from '~/lib/convex-errors'
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { ProjectTeamDialog } from '~/components/projects/ProjectTeamDialog'
import { useCanManageProject } from '~/components/projects/useCanManageProject'

/**
 * The last screen before publishing: what is ready, what is not, and the
 * few settings that only matter once candidates are on their way.
 *
 * A "missing" item is a specific instruction that takes the recruiter to the
 * step that fixes it — they should never have to hunt for what is blocking.
 */
export function StepPublish({
  orgId,
  orgSlug,
  project,
  questions,
  criteria,
  blockers,
  onGoTo,
}: {
  orgId: Id<'organizations'>
  orgSlug: string
  project: WizardProject
  questions: Array<WizardQuestion>
  criteria: Array<WizardCriterion>
  blockers: Array<PublishBlocker>
  onGoTo: (step: WizardStep) => void
}) {
  const { t } = useTranslation(['projects', 'common'])
  const update = useConvexMutation(api.projects.update)
  const canManage = useCanManageProject(orgSlug, project.createdBy)
  const [editingTeam, setEditingTeam] = useState(false)
  const [expiresAt, setExpiresAt] = useState(
    project.expiresAt ? toDateInput(project.expiresAt) : '',
  )

  const saveExpiry = async () => {
    try {
      await update({
        projectId: project._id,
        expiresAt: expiresAt ? Date.parse(`${expiresAt}T23:59:59`) : null,
      })
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('projects:review.title')}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          {t('projects:review.subtitle')}
        </p>
      </div>

      {blockers.length === 0 ? (
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
              {blockers.map((blocker) => (
                <li key={`${blocker.code}-${'position' in blocker ? blocker.position : 0}`}>
                  <button
                    type="button"
                    className="text-left underline underline-offset-4 hover:no-underline"
                    onClick={() => onGoTo(stepOfBlocker(blocker))}
                  >
                    {t(`projects:review.missing.${blocker.code}`, {
                      position:
                        'position' in blocker ? blocker.position : undefined,
                    })}
                  </button>
                </li>
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
          label={t('projects:questions.duration.label')}
          value={t('projects:questions.duration.value', {
            count: maxInterviewMinutes(questions),
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
      </dl>

      <section className="space-y-4 border-t pt-8">
        <h3 className="font-semibold">{t('projects:review.options')}</h3>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="project-expiry">
              {t('projects:basics.expiry')}
            </FieldLabel>
            <Input
              id="project-expiry"
              type="date"
              className="max-w-48"
              value={expiresAt}
              onChange={(event) => setExpiresAt(event.target.value)}
              onBlur={() => void saveExpiry()}
            />
            <FieldDescription>
              {t('projects:basics.expiryHint')}
            </FieldDescription>
          </Field>

          {canManage && (
            <Field>
              <FieldLabel>{t('projects:team.label')}</FieldLabel>
              <Button
                type="button"
                variant="outline"
                className="self-start"
                onClick={() => setEditingTeam(true)}
              >
                <Users className="size-4" />
                {t('projects:team.manage')}
              </Button>
              <FieldDescription>{t('projects:team.hint')}</FieldDescription>
            </Field>
          )}
        </FieldGroup>
      </section>

      {canManage && (
        <ProjectTeamDialog
          orgId={orgId}
          projectId={project._id}
          open={editingTeam}
          onOpenChange={setEditingTeam}
        />
      )}
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium tabular-nums">{value}</dd>
    </div>
  )
}

function toDateInput(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
