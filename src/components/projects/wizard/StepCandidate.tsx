import { useEffect, useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { StepCandidateForm } from './StepCandidateForm'
import type { WizardProject } from './types'
import { errorMessageKey } from '~/lib/convex-errors'
import { MediaRecorderField } from '~/components/projects/MediaRecorderField'
import { useProjectPlayback } from '~/components/projects/useProjectPlayback'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
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

const INTRO_MODES = ['none', 'video'] as const

/**
 * Everything the candidate sees of the role: its title, who welcomes them,
 * and what they are asked to hand over.
 *
 * One title, the public one. The internal name is only a disclosure away,
 * for the team that needs to tell two identical titles apart; while it is
 * closed, `title` follows `jobTitle` so the two cannot drift. A role that
 * already carries a distinct internal name opens with it shown.
 */
export function StepCandidate({ project }: { project: WizardProject }) {
  const { t } = useTranslation(['projects', 'common'])
  const update = useConvexMutation(api.projects.update)

  const [title, setTitle] = useState(project.title)
  const [jobTitle, setJobTitle] = useState(project.jobTitle ?? '')
  const [showInternal, setShowInternal] = useState(
    project.jobTitle !== project.title,
  )
  const [personaName, setPersonaName] = useState(project.personaName ?? '')
  const [introMode, setIntroMode] = useState(project.introMode)
  const { playback, refresh: refreshPlayback } = useProjectPlayback(
    project._id,
    project.hasIntroMedia ? 'intro' : '',
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
        <h2 className="text-lg font-semibold">
          {t('projects:experience.title')}
        </h2>
        <p className="text-muted-foreground max-w-prose text-sm">
          {t('projects:experience.subtitle')}
        </p>
      </section>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="project-job-title">
            {t('projects:new.fields.jobTitle')}
          </FieldLabel>
          <Input
            id="project-job-title"
            value={jobTitle}
            onChange={(event) => setJobTitle(event.target.value)}
            onBlur={() =>
              void save(
                showInternal
                  ? { projectId: project._id, jobTitle }
                  : { projectId: project._id, jobTitle, title: jobTitle },
              )
            }
          />
          <FieldDescription>
            {t('projects:new.fields.jobTitleHint')}
          </FieldDescription>
          {!showInternal && (
            <Button
              type="button"
              variant="link"
              className="h-auto self-start p-0"
              onClick={() => setShowInternal(true)}
            >
              {t('projects:new.addInternalName')}
            </Button>
          )}
        </Field>

        {showInternal && (
          <Field>
            <FieldLabel htmlFor="project-title">
              {t('projects:new.fields.title')}
            </FieldLabel>
            <Input
              id="project-title"
              value={title}
              autoFocus={project.jobTitle === project.title}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() =>
                void save({
                  projectId: project._id,
                  title: title.trim() || jobTitle,
                })
              }
            />
            <FieldDescription>
              {t('projects:new.fields.titleHint')}
            </FieldDescription>
          </Field>
        )}

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

      </FieldGroup>

      <section className="space-y-4 border-t pt-8">
        <div className="space-y-1">
          <h3 className="font-semibold">
            {t('projects:basics.intro.title')}
          </h3>
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

          {introMode === 'video' && (
            <Field>
              <MediaRecorderField
                target={{ kind: 'intro', projectId: project._id }}
                hasMedia={project.hasIntroMedia}
                playback={
                  playback?.intro ? { url: playback.intro, kind: 'video' } : null
                }
                onChanged={refreshPlayback}
              />
              <FieldDescription>
                {t('projects:basics.intro.media.hint')}
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
      </section>

      <section className="border-t pt-8">
        <StepCandidateForm project={project} />
      </section>
    </div>
  )
}
