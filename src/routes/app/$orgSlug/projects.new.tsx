import { useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import { AppRouteError } from '~/components/app-shell/RouteFallbacks'

export const Route = createFileRoute('/app/$orgSlug/projects/new')({
  component: NewProjectPage,
  errorComponent: AppRouteError,
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
  const create = useConvexMutation(api.projects.create)
  const [submitting, setSubmitting] = useState(false)
  const [showInternal, setShowInternal] = useState(false)

  const schema = useMemo(
    () =>
      z.object({
        jobTitle: z
          .string()
          .trim()
          .min(1, t('projects:errors.invalid_title'))
          .max(120, t('projects:errors.invalid_title')),
        internalTitle: z
          .string()
          .trim()
          .max(120, t('projects:errors.invalid_title')),
      }),
    [t],
  )

  const form = useForm({
    defaultValues: { jobTitle: '', internalTitle: '' },
    validators: { onSubmit: schema },
    onSubmit: async ({ value }) => {
      if (!org) return
      setSubmitting(true)
      try {
        const { slug } = await create({
          orgId: org._id,
          jobTitle: value.jobTitle,
          internalTitle: value.internalTitle || undefined,
          // The team's language: it writes the reports and the emails. The
          // candidate can switch their own screens, and transcription detects
          // the language of each answer.
          language: getLocale(),
        })
        // Straight into the wizard: a role with no questions is not yet
        // useful, and sending the recruiter back to a list would hide that.
        await navigate({
          to: '/app/$orgSlug/projects/$projectSlug/edit',
          params: { orgSlug, projectSlug: slug },
          search: {},
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
                      placeholder={t('projects:new.fields.jobTitlePlaceholder')}
                      onBlur={field.handleBlur}
                      onChange={(event) => field.handleChange(event.target.value)}
                      autoComplete="off"
                      autoFocus
                    />
                    <FieldDescription>
                      {t('projects:new.fields.jobTitleHint')}
                    </FieldDescription>
                    {field.state.meta.errors.length > 0 && (
                      <FieldError>
                        {String(field.state.meta.errors[0]?.message ?? '')}
                      </FieldError>
                    )}
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
                )}
              </form.Field>

              {showInternal && (
                <form.Field name="internalTitle">
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
                        onChange={(event) =>
                          field.handleChange(event.target.value)
                        }
                        autoComplete="off"
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
