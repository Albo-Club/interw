import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useForm } from '@tanstack/react-form'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'
import type { ReactNode } from 'react'

import type { AuthErrorLike } from '~/lib/auth-errors'
import type { SignInMethod } from '~/lib/auth-memory'
import { authClient } from '~/lib/auth-client'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { lastSignInMethod, rememberPendingCode } from '~/lib/auth-memory'
import { cn } from '~/lib/utils'
import { AUTH_CONTROL, AuthShell } from '~/components/auth/auth-shell'
import { PasswordInput } from '~/components/auth/password-input'
import { SocialAuthButtons } from '~/components/auth/social-auth-buttons'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Badge } from '~/components/ui/badge'
import { Button } from '~/components/ui/button'
import { CardContent, CardFooter } from '~/components/ui/card'
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { Input } from '~/components/ui/input'
import { Spinner } from '~/components/ui/spinner'

const CODE_LENGTH = 6
const RESEND_COOLDOWN_S = 30

type Props = {
  /** Heading and description of the first step. */
  title: ReactNode
  description?: ReactNode
  /** Shown above the form on the first step (verification notices…). */
  notice?: ReactNode
  /** An invitation's address: shown, not editable. */
  lockedEmail?: string
  initialEmail?: string
  /** Opened from the link in the code email: the code is prefilled. */
  link?: { email: string; code: string }
  /** Where Google, and the email link, return to. */
  redirect?: string
  /** A legacy sign-up verification link: completed with the password. */
  verifyToken?: string
  /** Open on the password form (legacy verification notices). */
  passwordFirst?: boolean
  /**
   * True from the moment a sign-in is sent until `onDone`, false if it fails.
   * Pages hold their "already signed in" redirects meanwhile: a new account
   * still has its name to give.
   */
  onBusyChange?: (busy: boolean) => void
  /** Signed in, every step done. */
  onDone: () => void
}

type Step =
  | { kind: 'start'; password: boolean }
  | { kind: 'code'; email: string; fromLink: boolean }
  | { kind: 'revoked'; needsName: boolean }
  | { kind: 'name' }

/**
 * Sign-in and sign-up in one flow: Google, or an email code (which creates the
 * account on first use), or — for accounts that have one — a password.
 * The code step looks the same whether or not the address has an account.
 */
export function EmailSignIn(props: Props) {
  const { link, passwordFirst, onBusyChange, onDone } = props
  const [step, setStep] = useState<Step>(() =>
    link
      ? { kind: 'code', email: link.email, fromLink: true }
      : { kind: 'start', password: !!passwordFirst },
  )
  const [email, setEmail] = useState(
    props.lockedEmail ?? link?.email ?? props.initialEmail ?? '',
  )

  const signedIn = (result: { passwordRevoked: boolean; needsName: boolean }) => {
    if (result.passwordRevoked)
      setStep({ kind: 'revoked', needsName: result.needsName })
    else if (result.needsName) setStep({ kind: 'name' })
    else onDone()
  }
  const busy = (value: boolean) => onBusyChange?.(value)

  switch (step.kind) {
    case 'start':
      return (
        <StartStep
          // A fresh form per mode: the other mode's validation goes with it.
          key={String(step.password)}
          {...props}
          email={email}
          password={step.password}
          onPasswordChange={(password, typed) => {
            setEmail(typed)
            setStep({ kind: 'start', password })
          }}
          onCodeSent={(sentTo) => {
            setEmail(sentTo)
            setStep({ kind: 'code', email: sentTo, fromLink: false })
          }}
          onBusy={busy}
        />
      )
    case 'code':
      return (
        <CodeStep
          key={`${step.email}:${step.fromLink}`}
          email={step.email}
          redirect={props.redirect}
          initialCode={step.fromLink ? link?.code : undefined}
          fromLink={step.fromLink}
          locked={!!props.lockedEmail}
          onResent={() =>
            setStep({ kind: 'code', email: step.email, fromLink: false })
          }
          onBack={() => setStep({ kind: 'start', password: false })}
          onBusy={busy}
          onSignedIn={signedIn}
        />
      )
    case 'revoked':
      return (
        <RevokedStep
          onContinue={() =>
            step.needsName ? setStep({ kind: 'name' }) : onDone()
          }
        />
      )
    case 'name':
      return <NameStep onDone={onDone} />
  }
}

function LastUsed({ show }: { show: boolean }) {
  const { t } = useTranslation('auth')
  if (!show) return null
  return <Badge variant="secondary">{t('lastUsed')}</Badge>
}

function useLastMethod() {
  // Read after mount: storage does not exist during SSR, and the badge must
  // not differ between the server render and hydration.
  const [method, setMethod] = useState<SignInMethod | null>(null)
  useEffect(() => setMethod(lastSignInMethod()), [])
  return method
}

function StartStep({
  title,
  description,
  notice,
  lockedEmail,
  redirect,
  verifyToken,
  email,
  password: passwordMode,
  onPasswordChange,
  onCodeSent,
  onBusy,
  onDone,
}: Props & {
  email: string
  password: boolean
  onPasswordChange: (password: boolean, typedEmail: string) => void
  onCodeSent: (email: string) => void
  onBusy: (busy: boolean) => void
}) {
  const { t } = useTranslation(['auth', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const lastMethod = useLastMethod()
  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [unverified, setUnverified] = useState<string | null>(null)
  const [resending, setResending] = useState(false)

  const schema = useMemo(
    () =>
      z.object({
        // Pasted addresses often carry a trailing space.
        email: z.string().trim().pipe(z.email(t('validation:email.invalid'))),
        password: passwordMode
          ? z.string().min(1, t('validation:password.required'))
          : z.string(),
      }),
    [t, passwordMode],
  )

  const form = useForm({
    defaultValues: { email, password: '' },
    validators: { onChange: schema, onSubmit: schema },
    onSubmitInvalid: ({ formApi }) => {
      if (!formApi.getFieldMeta('email')?.isValid) emailRef.current?.focus()
      else passwordRef.current?.focus()
    },
    onSubmit: async ({ value }) => {
      setSubmitError(null)
      const address = value.email.trim()
      if (!passwordMode) {
        const { error } = await authClient.emailOtp.sendVerificationOtp({
          email: address,
          type: 'sign-in',
        })
        if (error) {
          setSubmitError(sendErrorMessage(error, te))
          emailRef.current?.focus()
          return
        }
        rememberPendingCode(address.toLowerCase(), redirect)
        onCodeSent(address.toLowerCase())
        return
      }
      onBusy(true)
      const { error } = await authClient.signIn.email({
        email: address,
        password: value.password,
        ...(verifyToken ? { verifyToken } : {}),
      })
      if (error) {
        onBusy(false)
        const code = classifyAuthError(error)
        if (code === 'EMAIL_NOT_VERIFIED') {
          setUnverified(address)
          return
        }
        setSubmitError(formatAuthError(code, 'signin', te))
        passwordRef.current?.focus()
        return
      }
      onDone()
    },
  })

  // The cursor goes where the next keystroke goes: the password once the
  // address is known, the address otherwise.
  const focusPassword = passwordMode && !!email
  // A verification link completes only with the account's password. A code
  // would delete that password (the account is unverified), and Google
  // refuses the account and points to the code: neither is offered here.
  const passwordOnly = !!verifyToken

  const onResendVerification = async () => {
    if (!unverified) return
    setResending(true)
    const { error } = await authClient.sendVerificationEmail({
      email: unverified,
      callbackURL: redirect ?? '/app',
    })
    setResending(false)
    if (error) {
      toast.error(formatAuthError(classifyAuthError(error), 'send', te))
      return
    }
    toast.success(t('auth:signIn.verificationResent'))
  }

  return (
    <AuthShell title={title} description={description}>
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <CardContent className="flex flex-col gap-6">
          {!passwordOnly && (
            <SocialAuthButtons
              redirect={redirect}
              lastUsed={lastMethod === 'google'}
            />
          )}
          {notice}
          {submitError && (
            <Alert variant="destructive">
              <AlertDescription>{submitError}</AlertDescription>
            </Alert>
          )}
          {unverified && (
            <div
              role="status"
              className="border-border bg-muted/50 text-foreground rounded-md border p-3 text-sm"
            >
              <p className="mb-2">
                <Trans
                  t={t}
                  i18nKey="auth:signIn.unverified"
                  values={{ email: unverified }}
                />
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={AUTH_CONTROL}
                onClick={() => void onResendVerification()}
                disabled={resending}
              >
                {resending && <Spinner />}
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
                    <FieldLabel htmlFor="email">
                      {t('auth:fields.email')}
                    </FieldLabel>
                    <Input
                      ref={emailRef}
                      id="email"
                      name="email"
                      type="email"
                      inputMode="email"
                      autoComplete="username webauthn"
                      autoCapitalize="none"
                      spellCheck={false}
                      // A single primary field: focus it, unless the address
                      // is fixed by an invitation.
                      autoFocus={!lockedEmail && !focusPassword}
                      readOnly={!!lockedEmail}
                      placeholder={t('auth:start.emailPlaceholder')}
                      className={AUTH_CONTROL}
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
            {passwordMode && (
              <form.Field name="password">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor="password">
                        {t('auth:fields.password')}
                      </FieldLabel>
                      <PasswordInput
                        ref={passwordRef}
                        id="password"
                        name="password"
                        autoComplete="current-password"
                        autoFocus={focusPassword}
                        className={AUTH_CONTROL}
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
          </FieldGroup>
        </CardContent>
        <CardFooter className="flex-col gap-2">
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(submitting) => (
              <Button
                type="submit"
                className={cn('w-full', AUTH_CONTROL)}
                disabled={submitting}
              >
                {submitting && <Spinner />}
                {passwordMode
                  ? t('auth:signIn.submit')
                  : t('auth:start.continueWithEmail')}
                <LastUsed
                  show={lastMethod === (passwordMode ? 'password' : 'email')}
                />
              </Button>
            )}
          </form.Subscribe>
          <div className="flex w-full flex-wrap items-center justify-center gap-x-4">
            {passwordMode && (
              <form.Subscribe selector={(s) => s.values.email}>
                {(typed) => (
                  <Link
                    to="/forgot-password"
                    search={typed.trim() ? { email: typed.trim() } : {}}
                    className={cn(
                      'text-muted-foreground hover:text-foreground inline-flex items-center text-sm underline-offset-4 hover:underline',
                      AUTH_CONTROL,
                    )}
                  >
                    {t('auth:signIn.forgot')}
                  </Link>
                )}
              </form.Subscribe>
            )}
            {!passwordOnly && (
              <button
                type="button"
                onClick={() =>
                  onPasswordChange(!passwordMode, form.getFieldValue('email').trim())
                }
                className={cn(
                  'text-muted-foreground hover:text-foreground inline-flex items-center gap-2 text-sm underline-offset-4 hover:underline',
                  AUTH_CONTROL,
                )}
              >
                {passwordMode ? t('auth:start.useCode') : t('auth:start.usePassword')}
                <LastUsed show={!passwordMode && lastMethod === 'password'} />
              </button>
            )}
          </div>
        </CardFooter>
      </form>
    </AuthShell>
  )
}

/** Sending a code answers the same for every address: any error is real. */
function sendErrorMessage(error: AuthErrorLike, te: (k: string) => string) {
  const code = classifyAuthError(error)
  return formatAuthError(
    code === 'RATE_LIMITED' || code === 'NETWORK' || code === 'EMAIL_INVALID'
      ? code
      : 'UNKNOWN',
    'send',
    te,
  )
}

// Webmail inboxes worth a shortcut. A consumer address says which one; a work
// address is almost always hosted by one of the two, so both are offered.
const INBOXES = {
  gmail: 'https://mail.google.com/mail/u/0/#inbox',
  outlook: 'https://outlook.live.com/mail/0/inbox',
} as const
const OTHER_MAIL_PROVIDERS =
  /^((yahoo|ymail|aol|gmx|proton|protonmail)\.[a-z.]+|icloud\.com|me\.com|mac\.com|pm\.me|orange\.fr|wanadoo\.fr|free\.fr|sfr\.fr|neuf\.fr|laposte\.net)$/

function inboxesFor(email: string): Array<keyof typeof INBOXES> {
  const domain = email.split('@')[1]?.toLowerCase() ?? ''
  if (/^(gmail|googlemail)\.com$/.test(domain)) return ['gmail']
  if (/^(outlook|hotmail|live|msn)\.[a-z.]+$/.test(domain)) return ['outlook']
  if (OTHER_MAIL_PROVIDERS.test(domain)) return []
  return ['gmail', 'outlook']
}

function CodeStep({
  email,
  redirect,
  initialCode,
  fromLink,
  locked,
  onResent,
  onBack,
  onBusy,
  onSignedIn,
}: {
  email: string
  redirect?: string
  initialCode?: string
  fromLink: boolean
  locked: boolean
  onResent: () => void
  onBack: () => void
  onBusy: (busy: boolean) => void
  onSignedIn: (result: { passwordRevoked: boolean; needsName: boolean }) => void
}) {
  const { t } = useTranslation(['auth', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const inputRef = useRef<HTMLInputElement>(null)
  const [code, setCode] = useState(initialCode?.replace(/\D/g, '') ?? '')
  const [error, setError] = useState<string | null>(null)
  const [verifying, setVerifying] = useState(false)
  const [resending, setResending] = useState(false)
  // Opened from the email link: that code may be stale, so resending is
  // available at once. Otherwise a code has just been sent.
  const [resendAt, setResendAt] = useState(() =>
    fromLink ? 0 : Date.now() + RESEND_COOLDOWN_S * 1000,
  )
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (resendAt <= now) return
    const timer = window.setTimeout(() => setNow(Date.now()), 1000)
    return () => window.clearTimeout(timer)
  }, [now, resendAt])
  const cooldown = Math.max(0, Math.ceil((resendAt - now) / 1000))

  const verify = async (otp: string) => {
    if (verifying) return
    setError(null)
    setVerifying(true)
    onBusy(true)
    const { data, error: failure } = await authClient.signIn.emailOtp({
      email,
      otp,
    })
    if (failure) {
      onBusy(false)
      setVerifying(false)
      const kind = classifyAuthError(failure)
      setError(
        formatAuthError(
          kind === 'EMAIL_NOT_VERIFIED' || kind === 'INVALID_CREDENTIALS'
            ? 'CODE_INVALID'
            : kind,
          'signin',
          te,
        ),
      )
      setCode('')
      inputRef.current?.focus()
      return
    }
    // `passwordRevoked` is added by `revokedPasswordNotice` (convex/auth.ts).
    onSignedIn({
      passwordRevoked:
        'passwordRevoked' in data && data.passwordRevoked === true,
      needsName: !data.user.name.trim(),
    })
  }

  const resend = async () => {
    setError(null)
    setResending(true)
    const { error: failure } = await authClient.emailOtp.sendVerificationOtp({
      email,
      type: 'sign-in',
    })
    setResending(false)
    if (failure) {
      setError(sendErrorMessage(failure, te))
      return
    }
    rememberPendingCode(email, redirect)
    toast.success(t('auth:code.resent'))
    setResendAt(Date.now() + RESEND_COOLDOWN_S * 1000)
    setNow(Date.now())
    setCode('')
    if (fromLink) onResent()
    else inputRef.current?.focus()
  }

  const inboxes = fromLink ? [] : inboxesFor(email)

  return (
    <AuthShell
      title={fromLink ? t('auth:code.linkTitle') : t('auth:code.title')}
      description={
        <Trans
          t={t}
          i18nKey={
            fromLink ? 'auth:code.linkDescription' : 'auth:code.description'
          }
          values={{ email }}
          components={{ strong: <strong className="break-words" /> }}
        />
      }
    >
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          if (code.length !== CODE_LENGTH) {
            setError(te('auth.CODE_INVALID'))
            inputRef.current?.focus()
            return
          }
          void verify(code)
        }}
      >
        <CardContent className="flex flex-col gap-4">
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="code">{t('auth:code.label')}</FieldLabel>
            <Input
              ref={inputRef}
              id="code"
              name="code"
              autoComplete="one-time-code"
              inputMode="numeric"
              pattern="[0-9]*"
              spellCheck={false}
              // The link case waits for a deliberate press on Confirm.
              autoFocus={!fromLink}
              placeholder={'0'.repeat(CODE_LENGTH)}
              className="h-14 pl-[0.5em] text-center text-2xl font-semibold tracking-[0.5em] tabular-nums md:text-2xl"
              value={code}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'code-error' : undefined}
              onChange={(e) => {
                // Accept a pasted "123 456" or "123-456" as well.
                const digits = e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH)
                setCode(digits)
                if (error) setError(null)
                if (digits.length === CODE_LENGTH && !fromLink) void verify(digits)
              }}
            />
            {error && <FieldError id="code-error">{error}</FieldError>}
          </Field>
          <Button
            type="submit"
            className={cn('w-full', AUTH_CONTROL)}
            disabled={verifying}
            autoFocus={fromLink}
          >
            {verifying && <Spinner />}
            {fromLink ? t('auth:code.confirm') : t('auth:code.submit')}
          </Button>
          {inboxes.length > 0 && (
            <div className="grid auto-cols-fr grid-flow-col gap-2">
              {inboxes.map((inbox) => (
                <Button
                  key={inbox}
                  asChild
                  variant="outline"
                  className={AUTH_CONTROL}
                >
                  <a href={INBOXES[inbox]} target="_blank" rel="noreferrer">
                    {inbox === 'gmail'
                      ? t('auth:code.openGmail')
                      : t('auth:code.openOutlook')}
                  </a>
                </Button>
              ))}
            </div>
          )}
        </CardContent>
        <CardFooter className="text-muted-foreground flex-col gap-1 text-sm">
          <p className="text-center">{t('auth:code.noCode')}</p>
          <div className="flex flex-wrap items-center justify-center gap-x-4">
            <button
              type="button"
              onClick={() => void resend()}
              disabled={cooldown > 0 || resending}
              className={cn(
                'text-foreground inline-flex items-center gap-2 underline-offset-4 hover:underline disabled:no-underline disabled:opacity-60',
                AUTH_CONTROL,
              )}
            >
              {resending && <Spinner />}
              {cooldown > 0 ? (
                <span className="tabular-nums">
                  {t('auth:code.resendIn', { seconds: cooldown })}
                </span>
              ) : (
                t('auth:code.resend')
              )}
            </button>
            <button
              type="button"
              onClick={onBack}
              className={cn(
                'hover:text-foreground inline-flex items-center underline-offset-4 hover:underline',
                AUTH_CONTROL,
              )}
            >
              {locked ? t('auth:code.back') : t('auth:code.differentEmail')}
            </button>
          </div>
        </CardFooter>
      </form>
    </AuthShell>
  )
}

function RevokedStep({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation('auth')
  return (
    <AuthShell
      title={t('revoked.title')}
      description={t('revoked.description')}
    >
      <CardFooter>
        <Button
          className={cn('w-full', AUTH_CONTROL)}
          autoFocus
          onClick={onContinue}
        >
          {t('revoked.continue')}
        </Button>
      </CardFooter>
    </AuthShell>
  )
}

function NameStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation(['auth', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const inputRef = useRef<HTMLInputElement>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  return (
    <AuthShell title={t('auth:name.title')} description={t('auth:name.description')}>
      <form
        className="flex flex-col gap-6"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault()
          const trimmed = name.trim()
          if (!trimmed) {
            setError(t('validation:name.required'))
            inputRef.current?.focus()
            return
          }
          setSaving(true)
          const { error: failure } = await authClient.updateUser({
            name: trimmed,
          })
          setSaving(false)
          if (failure) {
            setError(formatAuthError(classifyAuthError(failure), 'change', te))
            inputRef.current?.focus()
            return
          }
          onDone()
        }}
      >
        <CardContent>
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="name">{t('auth:fields.yourName')}</FieldLabel>
            <Input
              ref={inputRef}
              id="name"
              name="name"
              autoComplete="name"
              autoFocus
              maxLength={80}
              className={AUTH_CONTROL}
              value={name}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'name-error' : undefined}
              onChange={(e) => {
                setName(e.target.value)
                if (error) setError(null)
              }}
            />
            {error && <FieldError id="name-error">{error}</FieldError>}
          </Field>
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            className={cn('w-full', AUTH_CONTROL)}
            disabled={saving}
          >
            {saving && <Spinner />}
            {t('auth:name.submit')}
          </Button>
        </CardFooter>
      </form>
    </AuthShell>
  )
}
