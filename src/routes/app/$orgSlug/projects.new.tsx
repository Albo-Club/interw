import { useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { TeamPicker } from '~/components/projects/TeamPicker'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '~/components/ui/field'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

export const Route = createFileRoute('/app/$orgSlug/projects/new')({
  component: NewProjectPage,
  head: () => ({
    meta: [
      { title: getI18n(getLocale()).getFixedT(null, 'projects')('new.title') },
    ],
  }),
})

function NewProjectPage() {
  const { t } = useTranslation(['projects', 'validation', 'common'])
  const { orgSlug } = Route.useParams()
  const navigate = useNavigate()
  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })
  const me = useConvexQuery(api.users.me)
  const create = useConvexMutation(api.projects.create)
  const [submitting, setSubmitting] = useState(false)
  const [team, setTeam] = useState<Array<Id<'users'>>>([])

  const schema = useMemo(
    () =>
      z.object({
        title: z
          .string()
          .trim()
          .min(1, t('projects:errors.invalid_title'))
          .max(120, t('projects:errors.invalid_title')),
        jobTitle: z.string().trim().max(120, t('projects:errors.invalid_job_title')),
        language: z.enum(['fr', 'en']),
      }),
    [t],
  )

  const form = useForm({
    defaultValues: { title: '', jobTitle: '', language: 'fr' as 'fr' | 'en' },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      if (!org) return
      setSubmitting(true)
      try {
        const { slug } = await create({
          orgId: org._id,
          title: value.title,
          jobTitle: value.jobTitle || undefined,
          language: value.language,
          team,
        })
        // Straight into the wizard: a project with no questions is not yet
        // useful, and sending the recruiter back to a list would hide that.
        await navigate({
          to: '/app/$orgSlug/projects/$projectSlug/edit',
          params: { orgSlug, projectSlug: slug },
        })
      } catch (error) {
        const { key, fallbackKey } = errorMessageKey(error, 'projects')
        toast.error(t(key, { defaultValue: t(fallbackKey) }))
      } finally {
        setSubmitting(false)
      }
    },
  })

  return (
    <main className="flex-1 p-6">
      <Card className="mx-auto w-full max-w-xl">
        <CardHeader>
          <CardTitle>{t('projects:new.title')}</CardTitle>
          <CardDescription>{t('projects:new.subtitle')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit()
            }}
          >
            <FieldGroup>
              <form.Field name="title">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      {t('projects:new.fields.title')}
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      autoFocus
                    />
                    <FieldDescription>
                      {t('projects:new.fields.titleHint')}
                    </FieldDescription>
                    {field.state.meta.errors.length > 0 && (
                      <FieldError>
                        {String(field.state.meta.errors[0]?.message ?? '')}
                      </FieldError>
                    )}
                  </Field>
                )}
              </form.Field>

              <form.Field name="jobTitle">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      {t('projects:new.fields.jobTitle')}
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                    />
                    <FieldDescription>
                      {t('projects:new.fields.jobTitleHint')}
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>

              <form.Field name="language">
                {(field) => (
                  <Field>
                    <FieldLabel htmlFor={field.name}>
                      {t('projects:new.fields.language')}
                    </FieldLabel>
                    <Select
                      value={field.state.value}
                      onValueChange={(value) =>
                        field.handleChange(value as 'fr' | 'en')
                      }
                    >
                      <SelectTrigger id={field.name}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="fr">
                          {t('common:language.fr')}
                        </SelectItem>
                        <SelectItem value="en">
                          {t('common:language.en')}
                        </SelectItem>
                      </SelectContent>
                    </Select>
                    <FieldDescription>
                      {t('projects:new.fields.languageHint')}
                    </FieldDescription>
                  </Field>
                )}
              </form.Field>

              {org && (
                <FieldSet className="gap-3">
                  <FieldLegend variant="label" className="mb-0">
                    {t('projects:team.label')}
                  </FieldLegend>
                  <FieldDescription>{t('projects:team.hint')}</FieldDescription>
                  <TeamPicker
                    orgId={org._id}
                    creatorId={me?.kind === 'ready' ? me.user._id : undefined}
                    selected={team}
                    onChange={setTeam}
                  />
                </FieldSet>
              )}

              <div className="flex justify-end gap-2">
                <Button variant="outline" asChild>
                  <Link to="/app/$orgSlug/projects" params={{ orgSlug }}>
                    {t('projects:new.cancel')}
                  </Link>
                </Button>
                <Button type="submit" disabled={submitting || !org}>
                  {t('projects:new.submit')}
                </Button>
              </div>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  )
}
