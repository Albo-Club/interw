import { useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'

import { authClient } from '~/lib/auth-client'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { isPasswordPwned } from '~/lib/hibp'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { ConfirmPasswordField } from '~/components/auth/confirm-password-field'
import { PasswordInput } from '~/components/auth/password-input'
import { PasswordStrength } from '~/components/auth/password-strength'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { CardContent, CardFooter } from '~/components/ui/card'
import { AuthShell } from '~/components/auth/auth-shell'

// Better Auth redirects here with ?token=... when the user clicks the email
// link. If `error` is present (e.g. INVALID_TOKEN) we surface it. Any other
// search param is ignored.
const searchSchema = z.object({
  token: z.string().optional(),
  error: z.string().optional(),
})

export const Route = createFileRoute('/reset-password')({
  component: ResetPasswordPage,
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'auth')('reset.metaTitle'),
      },
    ],
  }),
})

function ResetPasswordPage() {
  const { t } = useTranslation(['auth', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const schema = useMemo(
    () =>
      z
        .object({
          newPassword: z.string().min(12, t('validation:password.min12')),
          confirmPassword: z.string().min(1, t('validation:password.confirm')),
        })
        .refine((v) => v.newPassword === v.confirmPassword, {
          message: t('validation:password.mismatch'),
          path: ['confirmPassword'],
        }),
    [t],
  )
  const { token, error } = Route.useSearch()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)

  const form = useForm({
    defaultValues: { newPassword: '', confirmPassword: '' },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      if (!token) return
      setLoading(true)
      const { error: resetError } = await authClient.resetPassword({
        newPassword: value.newPassword,
        token,
      })
      setLoading(false)
      if (resetError) {
        toast.error(formatAuthError(classifyAuthError(resetError), 'reset', te))
        return
      }
      toast.success(t('auth:reset.success'))
      navigate({ to: '/login' })
    },
  })

  if (!token || error) {
    return (
      <AuthShell
        title={t('auth:reset.invalidTitle')}
        description={t('auth:reset.invalidDescription')}
      >
        <CardFooter className="flex-col gap-3">
          <Button asChild className="w-full">
            <Link to="/forgot-password">{t('auth:reset.requestNew')}</Link>
          </Button>
          <Link to="/login" className="text-muted-foreground text-sm underline">
            {t('auth:backToSignIn')}
          </Link>
        </CardFooter>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title={t('auth:reset.title')}
      description={t('auth:reset.description')}
    >
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
            <form.Field
              name="newPassword"
              validators={{
                onBlurAsync: async ({ value }) => {
                  if (!value || value.length < 12) return undefined
                  const { pwned } = await isPasswordPwned(value)
                  return pwned
                    ? { message: t('validation:password.pwned') }
                    : undefined
                },
              }}
            >
              {(field) => {
                const invalid =
                  field.state.meta.isTouched && !field.state.meta.isValid
                const isValidating = field.state.meta.isValidating
                return (
                  <Field data-invalid={invalid || undefined}>
                    <FieldLabel htmlFor={field.name}>
                      {t('auth:fields.newPassword')}
                    </FieldLabel>
                    <PasswordInput
                      id={field.name}
                      name={field.name}
                      autoComplete="new-password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                    />
                    <FieldDescription>
                      {isValidating ? (
                        <span
                          className="flex items-center gap-1.5"
                          aria-live="polite"
                        >
                          <Spinner className="size-3" />
                          {t('auth:password.checking')}
                        </span>
                      ) : (
                        t('auth:password.hint')
                      )}
                    </FieldDescription>
                    <PasswordStrength value={field.state.value} />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            </form.Field>
            <form.Field name="confirmPassword">
              {(field) => (
                <form.Subscribe selector={(s) => s.values.newPassword}>
                  {(newPassword) => (
                    <ConfirmPasswordField
                      id={field.name}
                      password={newPassword}
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                    />
                  )}
                </form.Subscribe>
              )}
            </form.Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Spinner />}
            {t('auth:reset.submit')}
          </Button>
        </CardFooter>
      </form>
    </AuthShell>
  )
}
