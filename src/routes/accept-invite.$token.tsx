import { useEffect, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexAuth } from 'convex/react'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ConvexError } from 'convex/values'

import { api } from '../../convex/_generated/api'
import { authClient } from '~/lib/auth-client'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { EmailSignIn } from '~/components/auth/email-sign-in'
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '~/components/ui/card'

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

function AcceptInvitePage() {
  const { t } = useTranslation('auth')
  const { token } = Route.useParams()
  const navigate = useNavigate()
  const { isLoading: authLoading, isAuthenticated } = useConvexAuth()
  const preview = useConvexQuery(api.invitations.preview, { token })
  const me = useConvexQuery(api.users.me, isAuthenticated ? {} : 'skip')
  const acceptMutation = useConvexMutation(api.invitations.accept)
  const triedAccept = useRef(false)
  const [acceptError, setAcceptError] = useState<string | null>(null)
  // The sign-in form still has steps after its own sign-in (a new account's
  // name): hold the auto-accept, and keep the form on screen, until it is done.
  const [signingIn, setSigningIn] = useState(false)

  useEffect(() => {
    if (!preview || preview.kind !== 'ok') return
    if (authLoading || !isAuthenticated || signingIn) return
    if (me?.kind !== 'ready' && me?.kind !== 'unprovisioned') return
    const myEmail = me.kind === 'ready' ? me.user.email : null
    if (myEmail && myEmail.toLowerCase() !== preview.email.toLowerCase()) return
    if (triedAccept.current) return
    triedAccept.current = true
    ;(async () => {
      try {
        const { orgSlug } = await acceptMutation({ token })
        toast.success(t('acceptInvite.accepted'))
        navigate({ to: '/app/$orgSlug', params: { orgSlug } })
      } catch (err) {
        const code = err instanceof ConvexError ? (err.data as string) : ''
        const known = ['not_found', 'already_accepted', 'expired', 'email_mismatch']
        setAcceptError(
          known.includes(code)
            ? t(`acceptInvite.errors.${code}`)
            : t('acceptInvite.errors.generic'),
        )
        triedAccept.current = false
      }
    })()
  }, [preview, authLoading, isAuthenticated, signingIn, me, token, navigate, acceptMutation])

  if (!preview)
    return <LoadingCard message={t('acceptInvite.loadingInvitation')} />
  if (preview.kind === 'not_found') {
    return (
      <InfoCard
        title={t('acceptInvite.notFound.title')}
        message={t('acceptInvite.notFound.message')}
      />
    )
  }
  if (preview.kind === 'expired') {
    return (
      <InfoCard
        title={t('acceptInvite.expired.title')}
        message={t('acceptInvite.expired.message')}
      />
    )
  }
  if (preview.kind === 'already_accepted') {
    return (
      <InfoCard
        title={t('acceptInvite.alreadyAccepted.title')}
        message={t('acceptInvite.alreadyAccepted.message')}
      />
    )
  }

  if (authLoading && !signingIn) return <LoadingCard />

  if (isAuthenticated && !signingIn) {
    if (me?.kind !== 'ready' && me?.kind !== 'unprovisioned') {
      return <LoadingCard />
    }
    const myEmail = me.kind === 'ready' ? me.user.email : null
    const isMismatch =
      myEmail && myEmail.toLowerCase() !== preview.email.toLowerCase()
    if (isMismatch) {
      return <SwitchAccountCard preview={preview} currentEmail={myEmail} />
    }
    return (
      <LoadingCard
        message={
          acceptError ?? t('acceptInvite.joining', { orgName: preview.orgName })
        }
        error={!!acceptError}
      />
    )
  }

  // Google, a code emailed to the invited address (which proves it, and
  // creates the account on first use), or an existing password.
  return (
    <EmailSignIn
      title={t('acceptInvite.join', { orgName: preview.orgName })}
      description={
        <Trans
          t={t}
          i18nKey="acceptInvite.signInDescription"
          values={{ email: preview.email }}
        />
      }
      lockedEmail={preview.email}
      redirect={`/accept-invite/${token}`}
      onBusyChange={setSigningIn}
      onDone={() => setSigningIn(false)}
    />
  )
}

function LoadingCard({
  message,
  error = false,
}: {
  message?: string
  error?: boolean
}) {
  const { t } = useTranslation(['auth', 'common'])
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {error ? t('auth:acceptInvite.holdOn') : t('auth:acceptInvite.oneMoment')}
          </CardTitle>
          <CardDescription>
            {message ?? t('common:loadingEllipsis')}
          </CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </main>
  )
}

function InfoCard({ title, message }: { title: string; message: string }) {
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{message}</CardDescription>
        </CardHeader>
        <CardContent />
      </Card>
    </main>
  )
}

function SwitchAccountCard({
  preview,
  currentEmail,
}: {
  preview: Extract<Preview, { kind: 'ok' }>
  currentEmail: string
}) {
  const { t } = useTranslation('auth')
  const [loading, setLoading] = useState(false)
  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t('acceptInvite.wrongAccount.title')}</CardTitle>
          <CardDescription>
            <span className="block break-all">
              <Trans
                t={t}
                i18nKey="acceptInvite.wrongAccount.signedInAs"
                values={{ email: currentEmail }}
              />
            </span>
            <span className="mt-2 block break-all">
              <Trans
                t={t}
                i18nKey="acceptInvite.wrongAccount.invitationFor"
                values={{ email: preview.email }}
              />
            </span>
          </CardDescription>
        </CardHeader>
        <CardFooter className="flex-col gap-3">
          <Button
            className="w-full"
            disabled={loading}
            onClick={async () => {
              setLoading(true)
              await authClient.signOut()
              window.location.reload()
            }}
          >
            {loading && <Spinner />}
            {t('acceptInvite.wrongAccount.switch')}
          </Button>
        </CardFooter>
      </Card>
    </main>
  )
}
