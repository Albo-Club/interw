import { useMemo, useState } from 'react'
import { useForm } from '@tanstack/react-form'
import { useConvexAction } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'

import { api } from '../../../convex/_generated/api'
import { authClient } from '~/lib/auth-client'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { convexErrorCode } from '~/lib/convex-errors'
import { isPasswordPwned } from '~/lib/hibp'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { ConfirmPasswordField } from '~/components/auth/confirm-password-field'
import { PasswordInput } from '~/components/auth/password-input'
import { PasswordStrength } from '~/components/auth/password-strength'
import { SignInAgainButton } from '~/components/auth/sign-in-again-button'

const SET_PASSWORD_ERRORS = new Set([
  'session_not_fresh',
  'password_already_set',
  'password_too_short',
  'password_too_long',
])

type Props = {
  /** Whether the account has a password (a `credential` account). */
  hasPassword: boolean
  /** Words the strength meter should penalise: email, name. */
  userInputs: Array<string>
  onPasswordSet: () => void
}

/**
 * "Change password" for an account that has one; "Set a password" for one
 * that signs in another way (Google, email code) — asking the latter for a
 * current password could only ever fail. Mount it with `key={hasPassword}`
 * so switching mode starts a fresh form.
 */
export function PasswordSettings({
  hasPassword,
  userInputs,
  onPasswordSet,
}: Props) {
  const { t } = useTranslation(['account', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const setPassword = useConvexAction(api.users.setPassword)
  const [saving, setSaving] = useState(false)
  const [needsSignIn, setNeedsSignIn] = useState(false)

  const schema = useMemo(
    () =>
      z
        .object({
          currentPassword: hasPassword
            ? z.string().min(1, t('validation:required'))
            : z.string(),
          newPassword: z.string().min(12, t('validation:password.min12')),
          confirmPassword: z.string().min(1, t('validation:password.confirm')),
        })
        .refine((v) => !hasPassword || v.currentPassword !== v.newPassword, {
          message: t('validation:password.different'),
          path: ['newPassword'],
        })
        .refine((v) => v.newPassword === v.confirmPassword, {
          message: t('validation:password.mismatch'),
          path: ['confirmPassword'],
        }),
    [t, hasPassword],
  )

  const form = useForm({
    defaultValues: { currentPassword: '', newPassword: '', confirmPassword: '' },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value, formApi }) => {
      setSaving(true)
      if (hasPassword) {
        const { error } = await authClient.changePassword({
          currentPassword: value.currentPassword,
          newPassword: value.newPassword,
          revokeOtherSessions: true,
        })
        setSaving(false)
        if (error) {
          toast.error(formatAuthError(classifyAuthError(error), 'change', te))
          return
        }
        // The "password changed" email is sent by the server (convex/auth.ts).
        toast.success(t('account:password.changed'))
        formApi.reset()
        return
      }
      try {
        await setPassword({ newPassword: value.newPassword })
      } catch (error) {
        const code = convexErrorCode(error)
        setNeedsSignIn(code === 'session_not_fresh')
        toast.error(
          t(
            `account:password.errors.${code && SET_PASSWORD_ERRORS.has(code) ? code : 'unknown'}`,
          ),
        )
        return
      } finally {
        setSaving(false)
      }
      toast.success(t('account:password.added'))
      onPasswordSet()
    },
  })

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {hasPassword
            ? t('account:password.title')
            : t('account:password.setTitle')}
        </CardTitle>
        <CardDescription>
          {hasPassword
            ? t('account:password.description')
            : t('account:password.setDescription')}
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
            {needsSignIn && (
              <Alert>
                <AlertDescription className="flex flex-col items-start gap-3">
                  {t('account:password.errors.session_not_fresh')}
                  <SignInAgainButton returnTo="/app/me?tab=security">
                    {t('account:reauthAction')}
                  </SignInAgainButton>
                </AlertDescription>
              </Alert>
            )}
            {hasPassword && (
              <form.Field name="currentPassword">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('account:password.current')}
                      </FieldLabel>
                      <PasswordInput
                        id={field.name}
                        name={field.name}
                        autoComplete="current-password"
                        value={field.state.value}
                        onBlur={field.handleBlur}
                        onChange={(e) => field.handleChange(e.target.value)}
                        aria-invalid={invalid || undefined}
                      />
                      {invalid && (
                        <FieldError errors={field.state.meta.errors} />
                      )}
                    </Field>
                  )
                }}
              </form.Field>
            )}
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
                return (
                  <Field data-invalid={invalid || undefined}>
                    <FieldLabel htmlFor={field.name}>
                      {t('account:password.new')}
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
                    <FieldDescription>{t('account:password.hint')}</FieldDescription>
                    <PasswordStrength
                      value={field.state.value}
                      userInputs={userInputs}
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            </form.Field>
            <form.Field name="confirmPassword">
              {(field) => (
                <form.Subscribe
                  selector={(s) => ({
                    newPassword: s.values.newPassword,
                    submitted: s.submissionAttempts > 0,
                  })}
                >
                  {({ newPassword, submitted }) => (
                    <ConfirmPasswordField
                      id={field.name}
                      password={newPassword}
                      value={field.state.value}
                      onChange={field.handleChange}
                      onBlur={field.handleBlur}
                      errors={
                        field.state.meta.isBlurred || submitted
                          ? field.state.meta.errors
                          : undefined
                      }
                    />
                  )}
                </form.Subscribe>
              )}
            </form.Field>
            <Button type="submit" disabled={saving}>
              {saving && <Spinner />}
              {hasPassword
                ? t('account:password.change')
                : t('account:password.set')}
            </Button>
          </FieldGroup>
        </CardContent>
      </form>
    </Card>
  )
}
