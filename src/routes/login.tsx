import { useEffect, useMemo, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'

import { authClient } from '~/lib/auth-client'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { useAuthState, useRedirectWhenAuthenticated } from '~/lib/auth-state'
import { internalRedirectSearch } from '~/lib/safe-redirect'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Spinner } from '~/components/ui/spinner'
import { AuthShell } from '~/components/auth/auth-shell'
import { PasswordInput } from '~/components/auth/password-input'
import { SocialAuthButtons } from '~/components/auth/social-auth-buttons'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { CardContent, CardFooter } from '~/components/ui/card'

const searchSchema = z.object({
  // Internal paths only — this one is handed to `window.location.replace()`
  // after a successful sign-in, so an absolute URL here would be an open
  // redirect. See `~/lib/safe-redirect`.
  redirect: internalRedirectSearch,
  // Better Auth appends ?error=... when a social sign-in fails via
  // `errorCallbackURL`. We surface it as a toast on mount.
  error: z.string().optional(),
  // Set by the sign-up verification link (convex/auth.ts
  // `verificationRequiresCredential`): the email is verified only by a
  // sign-in that carries it together with the account's password.
  verifyToken: z.string().optional(),
  // Set by the same hook when the link's token is expired or bad. The router
  // JSON-parses search values, so `?verifyExpired=1` arrives as a number.
  verifyExpired: z.literal(1).optional().catch(undefined),
})

export const Route = createFileRoute('/login')({
  component: LoginPage,
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'auth')('signIn.metaTitle'),
      },
    ],
  }),
})

function LoginPage() {
  const { redirect, error: socialError, verifyToken, verifyExpired } =
    Route.useSearch()
  // A verification link opened in a browser signed in to another account:
  // explain instead of bouncing to /app and dropping the link's message.
  const fromVerifyLink = !!verifyToken || !!verifyExpired
  useRedirectWhenAuthenticated(!fromVerifyLink)
  const { user } = useAuthState()
  const { t } = useTranslation(['auth', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const schema = useMemo(
    () =>
      z.object({
        email: z.email(t('validation:email.invalid')),
        password: z.string().min(1, t('validation:password.required')),
      }),
    [t],
  )
  const emailSchema = useMemo(
    () => z.email(t('validation:email.enterValid')),
    [t],
  )
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [magicLoading, setMagicLoading] = useState(false)
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null)
  const [resendLoading, setResendLoading] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [signOutLoading, setSignOutLoading] = useState(false)

  useEffect(() => {
    // `account_not_linked`: Better Auth won't attach Google to a local account
    // whose email isn't verified yet (pre-account hijacking guard).
    if (socialError)
      toast.error(
        t(
          socialError === 'account_not_linked'
            ? 'auth:social.notLinked'
            : 'auth:social.error',
        ),
      )
  }, [socialError, t])

  const form = useForm({
    defaultValues: { email: '', password: '' },
    validators: { onChange: schema, onSubmit: schema },
    onSubmit: async ({ value }) => {
      setSubmitError(null)
      setLoading(true)
      const { error } = await authClient.signIn.email({
        ...value,
        ...(verifyToken ? { verifyToken } : {}),
      })
      setLoading(false)
      if (error) {
        const code = classifyAuthError(error)
        if (code === 'EMAIL_NOT_VERIFIED') {
          setUnverifiedEmail(value.email)
          return
        }
        setSubmitError(formatAuthError(code, 'signin', te))
        return
      }
      setUnverifiedEmail(null)
      // Only follow same-origin relative paths: `//host` and `/\host` are
      // treated as protocol-relative URLs by browsers (open redirect).
      if (redirect && /^\/(?![/\\])/.test(redirect))
        window.location.replace(redirect)
      else navigate({ to: '/app' })
    },
  })

  const onResendVerification = async () => {
    if (!unverifiedEmail) return
    setResendLoading(true)
    const { error } = await authClient.sendVerificationEmail({
      email: unverifiedEmail,
      callbackURL: redirect ?? '/app',
    })
    setResendLoading(false)
    if (error) {
      toast.error(formatAuthError(classifyAuthError(error), 'verify', te))
      return
    }
    toast.success(t('auth:signIn.verificationResent'))
  }

  const onMagicLink = async () => {
    const email = form.getFieldValue('email')
    const parsed = emailSchema.safeParse(email)
    if (!parsed.success) {
      form.setFieldMeta('email', (prev) => ({
        ...prev,
        errors: [{ message: t('validation:email.enterValid') }],
      }))
      return
    }
    setSubmitError(null)
    setMagicLoading(true)
    const { error } = await authClient.signIn.magicLink({
      email,
      callbackURL: redirect ?? '/app',
    })
    setMagicLoading(false)
    if (error) {
      const code = classifyAuthError(error)
      console.warn('[magic-link]', error.code ?? error.status, error.message)
      // NETWORK / RATE_LIMITED: surface so the user knows the link wasn't sent.
      // Other codes stay anti-enum and fall through to the neutral success toast.
      if (code === 'NETWORK' || code === 'RATE_LIMITED') {
        setSubmitError(formatAuthError(code, 'signin', te))
        return
      }
    }
    toast.success(t('auth:signIn.magicSent'))
  }

  const isInviteFlow = redirect?.startsWith('/accept-invite/') ?? false

  if (fromVerifyLink && user)
    return (
      <AuthShell title={t('auth:signIn.title')}>
        <CardContent>
          <Alert>
            <AlertDescription>
              <Trans
                t={t}
                i18nKey="auth:signIn.verifyOtherAccount"
                values={{ email: user.email }}
              />
            </AlertDescription>
          </Alert>
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button
            className="w-full"
            disabled={signOutLoading}
            onClick={async () => {
              setSignOutLoading(true)
              await authClient.signOut()
              setSignOutLoading(false)
            }}
          >
            {signOutLoading && <Spinner />}
            {t('auth:signIn.verifySignOut')}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => navigate({ to: '/app' })}
          >
            {t('auth:signIn.verifyStay')}
          </Button>
        </CardFooter>
      </AuthShell>
    )

  return (
    <AuthShell
      title={t('auth:signIn.title')}
      description={
        isInviteFlow
          ? t('auth:signIn.descriptionInvite')
          : t('auth:signIn.description')
      }
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <CardContent className="flex flex-col gap-6">
          <SocialAuthButtons redirect={redirect} />
          {fromVerifyLink && !unverifiedEmail && (
            <Alert>
              <AlertDescription>
                {t(
                  verifyToken
                    ? 'auth:signIn.verifyPending'
                    : 'auth:signIn.verifyExpired',
                )}
              </AlertDescription>
            </Alert>
          )}
          {submitError && !unverifiedEmail && (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
          {unverifiedEmail && (
            <div className="border-border bg-muted/50 text-foreground rounded-md border p-3 text-sm">
              <p className="mb-2">
                <Trans
                  t={t}
                  i18nKey="auth:signIn.unverified"
                  values={{ email: unverifiedEmail }}
                />
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onResendVerification}
                disabled={resendLoading}
              >
                {resendLoading && <Spinner />}
                {t('auth:signIn.resendVerification')}
              </Button>
            </div>
          )}
          <FieldGroup>
            <form.Field name="email">
              {(field) => {
                const invalid =
                  field.state.meta.isTouched && !field.state.meta.isValid
                return (
                  <Field data-invalid={invalid || undefined}>
                    <FieldLabel htmlFor={field.name}>
                      {t('auth:fields.email')}
                    </FieldLabel>
                    <Input
                      id={field.name}
                      name={field.name}
                      type="email"
                      autoComplete="email"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            </form.Field>
            <form.Field name="password">
              {(field) => {
                const invalid =
                  field.state.meta.isTouched && !field.state.meta.isValid
                return (
                  <Field data-invalid={invalid || undefined}>
                    <div className="flex items-center">
                      <FieldLabel htmlFor={field.name}>
                        {t('auth:fields.password')}
                      </FieldLabel>
                      <Link
                        to="/forgot-password"
                        className="text-muted-foreground ml-auto text-sm underline-offset-4 hover:underline"
                      >
                        {t('auth:signIn.forgot')}
                      </Link>
                    </div>
                    <PasswordInput
                      id={field.name}
                      name={field.name}
                      autoComplete="current-password"
                      value={field.state.value}
                      onBlur={field.handleBlur}
                      onChange={(e) => field.handleChange(e.target.value)}
                      aria-invalid={invalid || undefined}
                    />
                    {invalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            </form.Field>
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col gap-3">
          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Spinner />}
            {t('auth:signIn.submit')}
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={onMagicLink}
            disabled={magicLoading}
          >
            {magicLoading && <Spinner />}
            {t('auth:signIn.magicLink')}
          </Button>
          <p className="text-muted-foreground text-sm">
            <Trans
              t={t}
              i18nKey="auth:signIn.noAccount"
              components={{
                signup: (
                  <Link
                    to="/register"
                    search={redirect ? { redirect } : undefined}
                    className="underline"
                  />
                ),
              }}
            />
          </p>
        </CardFooter>
      </form>
    </AuthShell>
  )
}
