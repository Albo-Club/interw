import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexAuth } from 'convex/react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useForm } from '@tanstack/react-form'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'
import { emailsMatch } from '../../convex/lib/invitations'
import type { ReactNode } from 'react'

import { authClient } from '~/lib/auth-client'
import { convexErrorCode } from '~/lib/convex-errors'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { classifyAuthError, formatAuthError } from '~/lib/auth-errors'
import { isPasswordPwned } from '~/lib/hibp'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Spinner } from '~/components/ui/spinner'
import { AuthShell } from '~/components/auth/auth-shell'
import { PasswordInput } from '~/components/auth/password-input'
import { PasswordStrength } from '~/components/auth/password-strength'
import { VerificationSentCard } from '~/components/auth/verification-sent'
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
import { CardContent, CardFooter } from '~/components/ui/card'

export const Route = createFileRoute('/accept-invite/$token')({
  component: AcceptInvitePage,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(
          null,
          'auth',
        )('acceptInvite.metaTitle'),
      },
    ],
  }),
})

type Preview = NonNullable<
  ReturnType<typeof useConvexQuery<typeof api.invitations.preview>>
>
type OkPreview = Extract<Preview, { kind: 'ok' }>

type AcceptState =
  | { status: 'idle' | 'pending' }
  | { status: 'failed'; code: string }

const KNOWN_ACCEPT_ERRORS = ['not_found', 'already_accepted', 'expired']

function AcceptInvitePage() {
  const { t } = useTranslation(['auth', 'common'])
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth()
  const preview = useConvexQuery(api.invitations.preview, { token })
  const me = useConvexQuery(api.users.me, isAuthenticated ? {} : 'skip')
  const acceptMutation = useConvexMutation(api.invitations.accept)
  const triedAccept = useRef(false)
  const [accept, setAccept] = useState<AcceptState>({ status: 'idle' })

  // A brand-new account has no Convex row yet, but Better Auth already knows
  // its address. Using it lets the wrong-account check run before the accept
  // instead of surfacing afterwards as an `email_mismatch` error.
  const myEmail =
    me?.kind === 'ready'
      ? me.user.email
      : me?.kind === 'unprovisioned'
        ? me.baUser.email
        : null

  const runAccept = useCallback(async () => {
    setAccept({ status: 'pending' })
    try {
      const result = await acceptMutation({ token })
      if (result.joined) {
        toast.success(
          t('auth:acceptInvite.welcome', {
            orgName: result.orgName,
            role: t(`common:roles.${result.role}`),
          }),
        )
      }
      navigate({ to: '/app/$orgSlug', params: { orgSlug: result.orgSlug } })
    } catch (err) {
      setAccept({ status: 'failed', code: convexErrorCode(err) ?? 'generic' })
    }
  }, [acceptMutation, token, navigate, t])

  // Accept as soon as the right account is signed in. Also on an expired or
  // already-used link: `accept` is a no-op success for an existing member, so
  // someone re-opening their invitation lands in the organization instead of
  // on a dead end, and anyone else gets the card once the accept refuses.
  useEffect(() => {
    if (!preview || preview.kind === 'not_found') return
    if (authLoading || !isAuthenticated || myEmail === null) return
    if (preview.kind === 'ok' && !emailsMatch(myEmail, preview.email)) return
    if (triedAccept.current) return
    triedAccept.current = true
    void runAccept()
  }, [preview, authLoading, isAuthenticated, myEmail, runAccept])

  if (!preview) {
    return <LoadingCard message={t('auth:acceptInvite.loadingInvitation')} />
  }
  if (preview.kind !== 'ok') {
    const awaitingAccept =
      preview.kind !== 'not_found' &&
      (authLoading || (isAuthenticated && accept.status !== 'failed'))
    if (awaitingAccept) return <LoadingCard />
    return (
      <DeadEndCard preview={preview} token={token} signedIn={isAuthenticated} />
    )
  }

  if (authLoading) return <LoadingCard />

  if (isAuthenticated) {
    if (myEmail === null) return <LoadingCard />
    if (
      !emailsMatch(myEmail, preview.email) ||
      (accept.status === 'failed' && accept.code === 'email_mismatch')
    ) {
      return <SwitchAccountCard preview={preview} currentEmail={myEmail} />
    }
    if (accept.status === 'failed') {
      return (
        <AcceptErrorCard
          preview={preview}
          code={accept.code}
          onRetry={() => void runAccept()}
        />
      )
    }
    return (
      <LoadingCard
        message={t('auth:acceptInvite.joining', { orgName: preview.orgName })}
      />
    )
  }

  return preview.accountExists ? (
    <SignInToAccept preview={preview} />
  ) : (
    <SignUpToAccept preview={preview} token={token} />
  )
}

/** The frame of the sign-in and sign-up states: who invited you, to what. */
function InviteShell({
  preview,
  hint,
  children,
}: {
  preview: OkPreview
  hint: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation(['auth', 'common'])
  const role = t(`common:roles.${preview.role}`)
  return (
    <AuthShell
      title={t('auth:acceptInvite.join', { orgName: preview.orgName })}
      description={
        <>
          <span className="block">
            {preview.inviterName ? (
              <Trans
                t={t}
                i18nKey="auth:acceptInvite.summary"
                values={{
                  inviter: preview.inviterName,
                  orgName: preview.orgName,
                  role,
                }}
              />
            ) : (
              <Trans
                t={t}
                i18nKey="auth:acceptInvite.summaryNoInviter"
                values={{ orgName: preview.orgName, role }}
              />
            )}
          </span>
          <span className="mt-2 block break-words">{hint}</span>
        </>
      }
    >
      {children}
    </AuthShell>
  )
}

function LoadingCard({ message }: { message?: string }) {
  const { t } = useTranslation(['auth', 'common'])
  return (
    <AuthShell
      title={t('auth:acceptInvite.oneMoment')}
      description={
        <span
          role="status"
          className="inline-flex items-center justify-center gap-2"
        >
          <Spinner />
          {message ?? t('common:loadingEllipsis')}
        </span>
      }
    >
      {null}
    </AuthShell>
  )
}

function SignOutButton({
  label,
  variant,
}: {
  label: string
  variant?: 'default' | 'ghost'
}) {
  const [loading, setLoading] = useState(false)
  return (
    <Button
      variant={variant}
      className="w-full"
      disabled={loading}
      onClick={async () => {
        setLoading(true)
        await authClient.signOut()
        window.location.reload()
      }}
    >
      {loading && <Spinner />}
      {label}
    </Button>
  )
}

/**
 * A link that cannot be used. Never a dead end: it names who to ask where the
 * token still resolves, and always offers the next step.
 */
function DeadEndCard({
  preview,
  token,
  signedIn,
}: {
  preview: Exclude<Preview, OkPreview>
  token: string
  signedIn: boolean
}) {
  const { t } = useTranslation('auth')
  let title: string
  let message: string
  if (preview.kind === 'not_found') {
    title = t('acceptInvite.notFound.title')
    message = t('acceptInvite.notFound.message')
  } else if (preview.kind === 'expired') {
    title = t('acceptInvite.expired.title')
    message = preview.inviterName
      ? t('acceptInvite.expired.message', {
          inviter: preview.inviterName,
          orgName: preview.orgName,
        })
      : t('acceptInvite.expired.messageNoInviter', { orgName: preview.orgName })
  } else {
    title = t('acceptInvite.alreadyAccepted.title')
    message = t(
      signedIn
        ? 'acceptInvite.alreadyAccepted.messageSignedIn'
        : 'acceptInvite.alreadyAccepted.message',
      { orgName: preview.orgName },
    )
  }
  return (
    <AuthShell title={title} description={message}>
      <CardFooter className="flex-col gap-3">
        {signedIn ? (
          <Button asChild className="w-full">
            <Link to="/app">{t('acceptInvite.goToApp')}</Link>
          </Button>
        ) : (
          <Button asChild className="w-full">
            <Link to="/login" search={{ redirect: `/accept-invite/${token}` }}>
              {t('acceptInvite.signIn')}
            </Link>
          </Button>
        )}
      </CardFooter>
    </AuthShell>
  )
}

function AcceptErrorCard({
  preview,
  code,
  onRetry,
}: {
  preview: OkPreview
  code: string
  onRetry: () => void
}) {
  const { t } = useTranslation(['auth', 'common'])
  return (
    <AuthShell
      title={t('auth:acceptInvite.failed.title', { orgName: preview.orgName })}
      description={
        <span role="alert">
          {t(
            KNOWN_ACCEPT_ERRORS.includes(code)
              ? `auth:acceptInvite.errors.${code}`
              : 'auth:acceptInvite.errors.generic',
          )}
        </span>
      }
    >
      <CardFooter className="flex-col gap-3">
        <Button className="w-full" onClick={onRetry}>
          {t('common:actions.retry')}
        </Button>
        <Button asChild variant="outline" className="w-full">
          <Link to="/app">{t('auth:acceptInvite.goToApp')}</Link>
        </Button>
        <SignOutButton variant="ghost" label={t('auth:acceptInvite.signOut')} />
      </CardFooter>
    </AuthShell>
  )
}

function SwitchAccountCard({
  preview,
  currentEmail,
}: {
  preview: OkPreview
  currentEmail: string
}) {
  const { t } = useTranslation('auth')
  return (
    <AuthShell
      title={t('acceptInvite.wrongAccount.title')}
      description={
        <>
          <span className="block break-words">
            <Trans
              t={t}
              i18nKey="acceptInvite.wrongAccount.signedInAs"
              values={{ email: currentEmail }}
            />
          </span>
          <span className="mt-2 block break-words">
            <Trans
              t={t}
              i18nKey="acceptInvite.wrongAccount.invitationFor"
              values={{ email: preview.email }}
            />
          </span>
          <span className="mt-2 block break-words">
            {preview.inviterName
              ? t('acceptInvite.wrongAccount.askAdmin', {
                  inviter: preview.inviterName,
                  email: currentEmail,
                })
              : t('acceptInvite.wrongAccount.askAdminNoInviter', {
                  orgName: preview.orgName,
                  email: currentEmail,
                })}
          </span>
        </>
      }
    >
      <CardFooter className="flex-col gap-3">
        <SignOutButton label={t('acceptInvite.wrongAccount.switch')} />
        <Button asChild variant="outline" className="w-full">
          <Link to="/app">{t('acceptInvite.wrongAccount.stay')}</Link>
        </Button>
      </CardFooter>
    </AuthShell>
  )
}

function SignInToAccept({
  preview,
}: {
  preview: Extract<Preview, { kind: 'ok' }>
}) {
  const { t } = useTranslation(['auth', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const signInSchema = useMemo(
    () =>
      z.object({
        password: z.string().min(1, t('validation:password.required')),
      }),
    [t],
  )
  const [loading, setLoading] = useState(false)
  const [magicLoading, setMagicLoading] = useState(false)

  const form = useForm({
    defaultValues: { password: '' },
    validators: { onChange: signInSchema, onSubmit: signInSchema },
    onSubmit: async ({ value }) => {
      setLoading(true)
      const { error } = await authClient.signIn.email({
        email: preview.email,
        password: value.password,
      })
      setLoading(false)
      if (error) {
        toast.error(formatAuthError(classifyAuthError(error), 'signin', te))
        return
      }
      // useConvexAuth flips → auto-accept effect fires in parent
    },
  })

  const onMagicLink = async () => {
    setMagicLoading(true)
    const { error } = await authClient.signIn.magicLink({
      email: preview.email,
      callbackURL: window.location.pathname,
    })
    setMagicLoading(false)
    if (error) {
      toast.error(formatAuthError(classifyAuthError(error), 'signin', te))
      return
    }
    toast.success(t('auth:magic.sentInbox'))
  }

  return (
    <InviteShell
      preview={preview}
      hint={
        <Trans
          t={t}
          i18nKey="auth:acceptInvite.signInDescription"
          values={{ email: preview.email }}
        />
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
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-email">
                  {t('auth:fields.email')}
                </FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  value={preview.email}
                  readOnly
                  disabled
                />
              </Field>
              <form.Field name="password">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('auth:fields.password')}
                      </FieldLabel>
                      <PasswordInput
                        id={field.name}
                        name={field.name}
                        autoComplete="current-password"
                        autoFocus
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
            </FieldGroup>
          </CardContent>
          <CardFooter className="flex-col gap-3">
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Spinner />}
              {t('auth:acceptInvite.accept')}
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
          </CardFooter>
        </form>
    </InviteShell>
  )
}

function SignUpToAccept({
  preview,
  token,
}: {
  preview: Extract<Preview, { kind: 'ok' }>
  token: string
}) {
  const { t } = useTranslation(['auth', 'validation', 'errors'])
  const te = (k: string) => t(`errors:${k}`)
  const signUpSchema = useMemo(
    () =>
      z.object({
        name: z.string().min(1, t('validation:name.required')),
        password: z.string().min(12, t('validation:password.min12')),
      }),
    [t],
  )
  const [loading, setLoading] = useState(false)
  const [verificationSent, setVerificationSent] = useState(false)

  const form = useForm({
    defaultValues: { name: '', password: '' },
    validators: { onChange: signUpSchema, onSubmit: signUpSchema },
    onSubmit: async ({ value }) => {
      setLoading(true)
      const { error: signUpError } = await authClient.signUp.email({
        email: preview.email,
        password: value.password,
        name: value.name,
        // Token-gated: the signup databaseHook (convex/auth.ts) pre-verifies
        // the email when this token resolves to a pending invitation for
        // preview.email, so the invitee skips the verification round-trip.
        // callbackURL brings them back here if verification is ever required
        // (e.g. the token went stale between preview and submit). The client
        // type doesn't model `inviteToken`, but BA forwards it to the hook
        // via context.body — hence the cast.
        inviteToken: token,
        callbackURL: `/accept-invite/${token}`,
      } as Parameters<typeof authClient.signUp.email>[0])
      if (signUpError) {
        setLoading(false)
        toast.error(
          formatAuthError(classifyAuthError(signUpError), 'signup', te),
        )
        return
      }
      // Email is already verified, so sign in immediately: useConvexAuth flips
      // and the parent's auto-accept effect fires while we stay on this page.
      // If the token was not valid the email is unverified → signIn fails →
      // fall back to the verification screen (callbackURL returns here).
      const { error: signInError } = await authClient.signIn.email({
        email: preview.email,
        password: value.password,
      })
      setLoading(false)
      if (signInError) {
        setVerificationSent(true)
      }
    },
  })

  if (verificationSent) {
    return (
      <VerificationSentCard
        description={
          <Trans
            t={t}
            i18nKey="auth:acceptInvite.verifyDescription"
            values={{ email: preview.email, orgName: preview.orgName }}
          />
        }
      />
    )
  }

  return (
    <InviteShell
      preview={preview}
      hint={
        <Trans
          t={t}
          i18nKey="auth:acceptInvite.signUpDescription"
          values={{ email: preview.email }}
        />
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
          <CardContent>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-email">
                  {t('auth:fields.email')}
                </FieldLabel>
                <Input
                  id="invite-email"
                  type="email"
                  value={preview.email}
                  readOnly
                  disabled
                />
              </Field>
              <form.Field name="name">
                {(field) => {
                  const invalid =
                    field.state.meta.isTouched && !field.state.meta.isValid
                  return (
                    <Field data-invalid={invalid || undefined}>
                      <FieldLabel htmlFor={field.name}>
                        {t('auth:fields.yourName')}
                      </FieldLabel>
                      <Input
                        id={field.name}
                        autoComplete="name"
                        autoFocus
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
              <form.Field
                name="password"
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
                        {t('auth:fields.password')}
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
                      <PasswordStrength
                        value={field.state.value}
                        userInputs={[
                          preview.email,
                          form.getFieldValue('name'),
                        ]}
                      />
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
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Spinner />}
              {t('auth:acceptInvite.accept')}
            </Button>
          </CardFooter>
        </form>
    </InviteShell>
  )
}
