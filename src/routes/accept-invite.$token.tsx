import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexAuth } from 'convex/react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { api } from '../../convex/_generated/api'
import { emailsMatch } from '../../convex/lib/invitations'
import type { ReactNode } from 'react'

import { authClient } from '~/lib/auth-client'
import { convexErrorCode } from '~/lib/convex-errors'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { AuthShell } from '~/components/auth/auth-shell'
import { EmailSignIn } from '~/components/auth/email-sign-in'
import { CardFooter } from '~/components/ui/card'

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
  // The sign-in form still has steps after its own sign-in (a new account's
  // name): hold the auto-accept, and keep the form on screen, until it is done.
  const [signingIn, setSigningIn] = useState(false)

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
    if (authLoading || !isAuthenticated || signingIn || myEmail === null) return
    if (preview.kind === 'ok' && !emailsMatch(myEmail, preview.email)) return
    if (triedAccept.current) return
    triedAccept.current = true
    void runAccept()
  }, [preview, authLoading, isAuthenticated, signingIn, myEmail, runAccept])

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

  if (authLoading && !signingIn) return <LoadingCard />

  if (isAuthenticated && !signingIn) {
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

  // Google, a code emailed to the invited address (which proves it, and
  // creates the account on first use), or an existing password.
  return (
    <EmailSignIn
      title={t('acceptInvite.join', { orgName: preview.orgName })}
      description={
        <InviteSummary
          preview={preview}
          hint={
            <Trans
              t={t}
              i18nKey="acceptInvite.signInDescription"
              values={{ email: preview.email }}
            />
          }
        />
      }
      lockedEmail={preview.email}
      redirect={`/accept-invite/${token}`}
      onBusyChange={setSigningIn}
      onDone={() => setSigningIn(false)}
    />
  )
}

/** Who invited you, to what, as what: above the sign-in form. */
function InviteSummary({ preview, hint }: { preview: OkPreview; hint: ReactNode }) {
  const { t } = useTranslation(['auth', 'common'])
  const role = t(`common:roles.${preview.role}`)
  return (
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
