import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { WizardProject } from './types'
import { errorMessageKey } from '~/lib/convex-errors'
import { Switch } from '~/components/ui/switch'
import { Label } from '~/components/ui/label'

const FIELD_KEYS = ['phone', 'linkedin', 'cv', 'coverLetter'] as const

export function StepCandidateForm({ project }: { project: WizardProject }) {
  const { t } = useTranslation(['projects', 'common'])
  const update = useConvexMutation(api.projects.update)

  const set = async (
    key: (typeof FIELD_KEYS)[number],
    patch: { enabled?: boolean; required?: boolean },
  ) => {
    const current = project.candidateFields[key]
    const next = {
      enabled: patch.enabled ?? current.enabled,
      required: patch.required ?? current.required,
    }
    // "Required but not asked for" is not a state a recruiter can mean.
    if (!next.enabled) next.required = false
    try {
      await update({
        projectId: project._id,
        candidateFields: { ...project.candidateFields, [key]: next },
      })
    } catch (error) {
      const { key: messageKey, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(messageKey, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">
          {t('projects:candidateForm.title')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t('projects:candidateForm.subtitle')}
        </p>
      </section>

      <div className="divide-border divide-y rounded-md border">
        {FIELD_KEYS.map((key) => {
          const value = project.candidateFields[key]
          return (
            <div
              key={key}
              className="flex flex-wrap items-center justify-between gap-4 p-4"
            >
              <span className="font-medium">
                {t(`projects:candidateForm.fields.${key}`)}
              </span>
              <div className="flex items-center gap-6">
                <div className="flex items-center gap-2">
                  <Switch
                    id={`field-${key}-enabled`}
                    checked={value.enabled}
                    onCheckedChange={(checked) =>
                      void set(key, { enabled: checked })
                    }
                  />
                  <Label
                    htmlFor={`field-${key}-enabled`}
                    className="text-muted-foreground font-normal"
                  >
                    {t('projects:candidateForm.enabled')}
                  </Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id={`field-${key}-required`}
                    checked={value.required}
                    disabled={!value.enabled}
                    onCheckedChange={(checked) =>
                      void set(key, { required: checked })
                    }
                  />
                  <Label
                    htmlFor={`field-${key}-required`}
                    className="text-muted-foreground font-normal"
                  >
                    {t('projects:candidateForm.required')}
                  </Label>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
