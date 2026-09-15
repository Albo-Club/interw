import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { WizardCriterion, WizardProject } from './types'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Card, CardContent } from '~/components/ui/card'
import { Progress } from '~/components/ui/progress'
import { Field, FieldGroup, FieldLabel } from '~/components/ui/field'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { EmptyState } from '~/components/projects/EmptyState'

export function StepCriteria({
  project,
  criteria,
}: {
  project: WizardProject
  criteria: Array<WizardCriterion>
}) {
  const { t } = useTranslation(['projects', 'common'])
  const create = useConvexMutation(api.criteria.create)
  const remove = useConvexMutation(api.criteria.remove)
  const [pendingDelete, setPendingDelete] = useState<WizardCriterion | null>(
    null,
  )

  const notify = (error: unknown) => {
    const { key, fallbackKey } = errorMessageKey(error, 'projects')
    toast.error(t(key, { defaultValue: t(fallbackKey) }))
  }

  const add = () =>
    void create({
      projectId: project._id,
      label: t('projects:criteria.fields.labelPlaceholder'),
    }).catch(
      notify,
    )

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('projects:criteria.title')}</h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          {t('projects:criteria.subtitle')}
        </p>
      </div>

      {criteria.length === 0 ? (
        <EmptyState
          title={t('projects:criteria.empty.title')}
          body={t('projects:criteria.empty.body')}
          action={
            <Button onClick={add}>
              <Plus className="size-4" />
              {t('projects:criteria.add')}
            </Button>
          }
        />
      ) : (
        <>
          <ul className="space-y-4">
            {criteria.map((criterion) => (
              <li key={criterion._id}>
                <CriterionCard
                  criterion={criterion}
                  onDelete={() => setPendingDelete(criterion)}
                />
              </li>
            ))}
          </ul>
          <Button variant="outline" onClick={add}>
            <Plus className="size-4" />
            {t('projects:criteria.add')}
          </Button>
        </>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('projects:criteria.removeConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects:criteria.removeConfirm.body', {
                label: pendingDelete?.label ?? '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) {
                  void remove({ criterionId: pendingDelete._id }).catch(notify)
                }
                setPendingDelete(null)
              }}
            >
              {t('projects:criteria.removeConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function CriterionCard({
  criterion,
  onDelete,
}: {
  criterion: WizardCriterion
  onDelete: () => void
}) {
  const { t } = useTranslation(['projects', 'common'])
  const update = useConvexMutation(api.criteria.update)
  const [label, setLabel] = useState(criterion.label)
  const [description, setDescription] = useState(criterion.description ?? '')
  const [weight, setWeight] = useState(String(criterion.weight))

  const save = async (
    patch: Omit<Parameters<typeof update>[0], 'criterionId'>,
  ) => {
    try {
      await update({ criterionId: criterion._id, ...patch })
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <FieldGroup>
          <div className="flex items-start gap-4">
            <Field className="flex-1">
              <FieldLabel htmlFor={`c-label-${criterion._id}`}>
                {t('projects:criteria.fields.label')}
              </FieldLabel>
              <Input
                id={`c-label-${criterion._id}`}
                value={label}
                placeholder={t('projects:criteria.fields.labelPlaceholder')}
                onChange={(event) => setLabel(event.target.value)}
                onBlur={() => void save({ label })}
              />
            </Field>
            <Field className="w-28">
              <FieldLabel htmlFor={`c-weight-${criterion._id}`}>
                {t('projects:criteria.fields.weight')}
              </FieldLabel>
              <Input
                id={`c-weight-${criterion._id}`}
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                className="tabular-nums"
                value={weight}
                onChange={(event) => setWeight(event.target.value)}
                onBlur={() => {
                  const parsed = Number.parseInt(weight, 10)
                  if (Number.isNaN(parsed)) {
                    setWeight(String(criterion.weight))
                    return
                  }
                  void save({ weight: parsed })
                }}
              />
            </Field>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="text-destructive mt-6 size-8"
              onClick={onDelete}
              aria-label={t('projects:criteria.remove')}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>

          <Field>
            <FieldLabel htmlFor={`c-description-${criterion._id}`}>
              {t('projects:criteria.fields.description')}
            </FieldLabel>
            <Textarea
              id={`c-description-${criterion._id}`}
              rows={2}
              value={description}
              placeholder={t('projects:criteria.fields.descriptionPlaceholder')}
              onChange={(event) => setDescription(event.target.value)}
              onBlur={() => void save({ description })}
            />
          </Field>
        </FieldGroup>

        {/* The number the recruiter types is relative; this is what it means. */}
        <div className="space-y-1.5">
          <p className="text-muted-foreground text-xs tabular-nums">
            {t('projects:criteria.normalized', {
              percent: criterion.normalizedWeight,
            })}
          </p>
          <Progress value={criterion.normalizedWeight} />
        </div>
      </CardContent>
    </Card>
  )
}
