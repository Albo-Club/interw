import { useEffect, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { WizardProject } from './types'
import { errorMessageKey } from '~/lib/convex-errors'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'

const INTRO_MODES = ['none', 'text', 'audio', 'video'] as const

export function StepBasics({ project }: { project: WizardProject }) {
  const { t } = useTranslation(['projects', 'common'])
  const update = useConvexMutation(api.projects.update)

  const [title, setTitle] = useState(project.title)
  const [jobTitle, setJobTitle] = useState(project.jobTitle ?? '')
  const [personaName, setPersonaName] = useState(project.personaName ?? '')
  const [duration, setDuration] = useState(String(project.maxDurationMinutes))
  const [introMode, setIntroMode] = useState(project.introMode)
  const [introText, setIntroText] = useState(project.introText ?? '')
  const [expiresAt, setExpiresAt] = useState(
    project.expiresAt ? toDateInput(project.expiresAt) : '',
  )

  // Re-seed when the underlying project changes (another tab, or a save that
  // normalised a value). Local edits in flight are the common case, so this
  // only runs when the project identity changes.
  useEffect(() => {
    setTitle(project.title)
    setJobTitle(project.jobTitle ?? '')
  }, [project._id, project.title, project.jobTitle])

  const save = async (patch: Parameters<typeof update>[0]) => {
    try {
      await update(patch)
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-1">
        <h2 className="text-lg font-semibold">{t('projects:basics.title')}</h2>
        <p className="text-muted-foreground text-sm">
          {t('projects:basics.subtitle')}
        </p>
      </section>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-title">
            {t('projects:new.fields.title')}
          </FieldLabel>
          <Input
            id="project-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void save({ projectId: project._id, title })}
          />
          <FieldDescription>
            {t('projects:new.fields.titleHint')}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="project-job-title">
            {t('projects:new.fields.jobTitle')}
          </FieldLabel>
          <Input
            id="project-job-title"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
            onBlur={() => void save({ projectId: project._id, jobTitle })}
          />
          <FieldDescription>
            {t('projects:new.fields.jobTitleHint')}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="project-persona">
            {t('projects:basics.persona')}
          </FieldLabel>
          <Input
            id="project-persona"
            value={personaName}
            onChange={(event) => setPersonaName(event.target.value)}
            onBlur={() => void save({ projectId: project._id, personaName })}
          />
          <FieldDescription>
            {t('projects:basics.personaHint')}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="project-duration">
            {t('projects:basics.duration')}
          </FieldLabel>
          <Input
            id="project-duration"
            type="number"
            min={5}
            max={120}
            inputMode="numeric"
            className="max-w-32 tabular-nums"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            onBlur={() => {
              const parsed = Number.parseInt(duration, 10)
              if (Number.isNaN(parsed)) {
                setDuration(String(project.maxDurationMinutes))
                return
              }
              void save({
                projectId: project._id,
                maxDurationMinutes: parsed,
              })
            }}
          />
          <FieldDescription>
            {t('projects:basics.durationHint')}
          </FieldDescription>
        </Field>

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
            onBlur={() =>
              void save({
                projectId: project._id,
                expiresAt: expiresAt ? Date.parse(`${expiresAt}T23:59:59`) : null,
              })
            }
          />
          <FieldDescription>{t('projects:basics.expiryHint')}</FieldDescription>
        </Field>
      </FieldGroup>

      <section className="space-y-4 border-t pt-8">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {t('projects:basics.intro.title')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('projects:basics.intro.subtitle')}
          </p>
        </div>

        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="project-intro-mode">
              {t('projects:basics.intro.title')}
            </FieldLabel>
            <Select
              value={introMode}
              onValueChange={(value) => {
                const mode = value as (typeof INTRO_MODES)[number]
                setIntroMode(mode)
                void save({ projectId: project._id, introMode: mode })
              }}
            >
              <SelectTrigger id="project-intro-mode" className="max-w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {INTRO_MODES.map((mode) => (
                  <SelectItem key={mode} value={mode}>
                    {t(`projects:basics.intro.mode.${mode}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {introMode === 'text' && (
            <Field>
              <FieldLabel htmlFor="project-intro-text">
                {t('projects:basics.intro.text')}
              </FieldLabel>
              <Textarea
                id="project-intro-text"
                rows={5}
                value={introText}
                placeholder={t('projects:basics.intro.textPlaceholder')}
                onChange={(event) => setIntroText(event.target.value)}
                onBlur={() => void save({ projectId: project._id, introText })}
              />
            </Field>
          )}
        </FieldGroup>
      </section>
    </div>
  )
}

function toDateInput(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}
