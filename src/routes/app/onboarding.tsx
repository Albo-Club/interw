import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm, useStore } from '@tanstack/react-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { Check, LogOut, X } from 'lucide-react'

import { api } from '../../../convex/_generated/api'
import { slugify } from '../../../convex/lib/slug'
import { authClient } from '~/lib/auth-client'
import { convexErrorCode } from '~/lib/convex-errors'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { Logo } from '~/components/Logo'
import { LanguageSwitcher } from '~/components/i18n/LanguageSwitcher'
import { PendingInvitations } from '~/components/app-shell/PendingInvitations'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Spinner } from '~/components/ui/spinner'
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
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

// Mirrors convex/organizations.ts, which validates again on create.
const SLUG_RE = /^[a-z0-9-]{3,40}$/
const MAX_NAME_LENGTH = 80

/** The address a name suggests, until the person edits it themselves. */
function slugFromName(name: string): string {
  return slugify(name).slice(0, 40).replace(/-+$/, '')
}

export const Route = createFileRoute('/app/onboarding')({
  component: OnboardingPage,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'nav')(
          'onboarding.metaTitle',
        ),
      },
    ],
  }),
})

function OnboardingPage() {
  const navigate = useNavigate()
  const { t } = useTranslation(['nav', 'validation', 'account'])
  const me = useConvexQuery(api.users.me)
  const hasOrgs = me?.kind === 'ready' && me.orgs.length > 0
  const email = me?.kind === 'ready' ? me.user.email : ''
  const schema = useMemo(
    () =>
      z.object({
        name: z
          .string()
          .trim()
          .min(1, t('validation:name.required'))
          .max(MAX_NAME_LENGTH, t('validation:name.tooLong')),
        slug: z.string().regex(SLUG_RE, t('nav:onboarding.errors.invalidSlug')),
      }),
    [t],
  )
  const create = useConvexMutation(api.organizations.create)
  const [loading, setLoading] = useState(false)
  const [slugEdited, setSlugEdited] = useState(false)

  const form = useForm({
    defaultValues: { name: '', slug: '' },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      setLoading(true)
      try {
        const { slug } = await create(value)
        toast.success(t('nav:onboarding.created'))
        navigate({ to: '/app/$orgSlug', params: { orgSlug: slug } })
      } catch (err) {
        const code = convexErrorCode(err) ?? ''
        const messages: Record<string, string> = {
          slug_taken: t('nav:onboarding.errors.slugTaken'),
          slug_reserved: t('nav:onboarding.errors.slugReserved'),
          invalid_slug: t('nav:onboarding.errors.invalidSlug'),
          invalid_name: t('nav:onboarding.errors.invalidName'),
        }
        toast.error(messages[code] ?? t('nav:onboarding.errors.couldNotCreate'))
      } finally {
        setLoading(false)
      }
    },
  })

  // Only query when the shape is valid — saves a roundtrip on every keystroke
  // while the user is mid-typing.
  const slug = useStore(form.store, (s) => s.values.slug)
  const shapeValid = SLUG_RE.test(slug)
  const availability = useConvexQuery(
    api.organizations.checkSlug,
    shapeValid ? { slug } : 'skip',
  )
  // An invalid shape keeps the button live so submitting surfaces the error;
  // a taken or still-checking address does not.
  const slugBlocked =
    shapeValid && (availability === undefined || !availability.available)
  // Read after mount: the server has no `window`, and a host rendered only on
  // the client would not match the server HTML.
  const [host, setHost] = useState('')
  useEffect(() => setHost(window.location.host), [])

  async function handleSignOut() {
    await authClient.signOut()
    navigate({ to: '/login' })
  }

  return (
    <main className="bg-muted flex min-h-svh flex-col items-center justify-center p-6 md:p-10">
      <div className="flex w-full max-w-md flex-col gap-6">
        <Logo className="self-center" />

        <PendingInvitations variant="onboarding" />

        <Card>
          <CardHeader>
            <CardTitle>{t('nav:onboarding.title')}</CardTitle>
            <CardDescription>
              {t(
                hasOrgs
                  ? 'nav:onboarding.descriptionAnother'
                  : 'nav:onboarding.description',
              )}
            </CardDescription>
          </CardHeader>
          <form
            className="flex flex-col gap-6"
            onSubmit={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void form.handleSubmit()
            }}
          >
            <CardContent>
              <FieldGroup>
                <form.Field name="name">
                  {(field) => {
                    const invalid =
                      field.state.meta.isTouched && !field.state.meta.isValid
                    return (
                      <Field data-invalid={invalid || undefined}>
                        <FieldLabel htmlFor={field.name}>
                          {t('nav:onboarding.name')}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          autoComplete="organization"
                          placeholder={t('nav:onboarding.namePlaceholder')}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            field.handleChange(e.target.value)
                            if (!slugEdited) {
                              form.setFieldValue(
                                'slug',
                                slugFromName(e.target.value),
                              )
                            }
                          }}
                          aria-invalid={invalid || undefined}
                        />
                        {invalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    )
                  }}
                </form.Field>
                <form.Field name="slug">
                  {(field) => {
                    const invalid =
                      field.state.meta.isTouched && !field.state.meta.isValid
                    return (
                      <Field data-invalid={invalid || undefined}>
                        <FieldLabel htmlFor={field.name}>
                          {t('nav:onboarding.slug')}
                        </FieldLabel>
                        <Input
                          id={field.name}
                          name={field.name}
                          autoComplete="off"
                          spellCheck={false}
                          translate="no"
                          placeholder={t('nav:onboarding.slugPlaceholder')}
                          value={field.state.value}
                          onBlur={field.handleBlur}
                          onChange={(e) => {
                            setSlugEdited(true)
                            field.handleChange(e.target.value.toLowerCase())
                          }}
                          aria-invalid={invalid || undefined}
                        />
                        <FieldDescription>
                          <span className="block break-all" translate="no">
                            {host}/app/
                            <strong className="text-foreground font-medium">
                              {field.state.value ||
                                t('nav:onboarding.slugFallback')}
                            </strong>
                          </span>
                          <span className="mt-1 block">
                            {t('nav:onboarding.slugPermanent')}
                          </span>
                        </FieldDescription>
                        {shapeValid && (
                          <SlugAvailability result={availability} />
                        )}
                        {invalid && (
                          <FieldError errors={field.state.meta.errors} />
                        )}
                      </Field>
                    )
                  }}
                </form.Field>
              </FieldGroup>
            </CardContent>
            <CardFooter>
              <Button
                type="submit"
                className="w-full"
                disabled={loading || slugBlocked}
              >
                {loading && <Spinner />}
                {t('nav:onboarding.submit')}
              </Button>
            </CardFooter>
          </form>
        </Card>

        {!hasOrgs && (
          <p className="text-muted-foreground text-center text-sm text-balance">
            {t('nav:onboarding.waitingHint', { email })}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-center gap-2">
          {hasOrgs && (
            <Button asChild variant="ghost" size="sm">
              <Link to="/app">{t('nav:onboarding.backToApp')}</Link>
            </Button>
          )}
          <LanguageSwitcher />
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            <LogOut aria-hidden="true" />
            {t('account:menu.signOut')}
          </Button>
        </div>
      </div>
    </main>
  )
}

function SlugAvailability({
  result,
}: {
  result: { available: true } | { available: false; reason: 'invalid' | 'reserved' | 'taken' } | undefined
}) {
  const { t } = useTranslation('nav')
  if (result === undefined) {
    return (
      <p
        className="text-muted-foreground flex items-center gap-1.5 text-xs"
        aria-live="polite"
      >
        <Spinner className="size-3" />
        {t('onboarding.availability.checking')}
      </p>
    )
  }
  if (result.available) {
    return (
      <p
        className="flex items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-400"
        aria-live="polite"
      >
        <Check className="size-3.5" aria-hidden="true" />
        {t('onboarding.availability.available')}
      </p>
    )
  }
  const reasonText: Record<typeof result.reason, string> = {
    invalid: t('onboarding.availability.invalid'),
    reserved: t('onboarding.availability.reserved'),
    taken: t('onboarding.availability.taken'),
  }
  return (
    <p
      className="text-destructive flex items-center gap-1.5 text-xs"
      aria-live="polite"
    >
      <X className="size-3.5" aria-hidden="true" />
      {reasonText[result.reason]}
    </p>
  )
}
