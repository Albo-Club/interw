import { useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { Trans, useTranslation } from 'react-i18next'
import { z } from 'zod'

import { authClient } from '~/lib/auth-client'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { useAuthState, useRedirectWhenAuthenticated } from '~/lib/auth-state'
import { internalRedirectSearch } from '~/lib/safe-redirect'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'
import { AUTH_CONTROL, AuthShell } from '~/components/auth/auth-shell'
import { EmailSignIn } from '~/components/auth/email-sign-in'
import { CardContent, CardFooter } from '~/components/ui/card'

const searchSchema = z.object({
  // Internal paths only — followed after a successful sign-in, so an absolute
  // URL here would be an open redirect. See `~/lib/safe-redirect`.
  redirect: internalRedirectSearch,
  // `/register` lands here with `mode=signup`: same flow, other heading.
  mode: z.literal('signup').optional().catch(undefined),
  // Prefills the address (e.g. back from "Get a new code").
  email: z.string().max(254).optional().catch(undefined),
  // Better Auth appends ?error=... when a Google sign-in fails or is
  // cancelled (`errorCallbackURL`, and `onAPIError.errorURL` in convex/auth.ts).
  error: z.string().optional().catch(undefined),
  // Set by the legacy sign-up verification link (convex/auth.ts
  // `verificationRequiresCredential`): the email is verified only by a
  // sign-in that carries it together with the account's password.
  verifyToken: z.string().optional().catch(undefined),
  // The router JSON-parses search values, so `?verifyExpired=1` arrives as a
  // number. Set by the same hook when the link's token is expired or bad.
  verifyExpired: z.literal(1).optional().catch(undefined),
  // Set by the /app guard when this browser lost a session it never signed
  // out of.
  expired: z.literal(1).optional().catch(undefined),
})

export const Route = createFileRoute('/login')({
  component: LoginPage,
  validateSearch: searchSchema,
  head: ({ match }) => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'auth')(
          match.search.mode === 'signup' ? 'signIn.metaTitleSignup' : 'signIn.metaTitle',
        ),
      },
    ],
  }),
})

// Google comes back with a code in `?error=`; only a few deserve their own words.
const SOCIAL_ERRORS: Partial<Record<string, string>> = {
  // Better Auth won't attach Google to a local account whose email isn't
  // verified yet (pre-account hijacking guard).
  account_not_linked: 'auth:social.notLinked',
  access_denied: 'auth:social.cancelled',
}

function LoginPage() {
  const search = Route.useSearch()
  const { redirect, verifyToken, verifyExpired } = search
  const { t } = useTranslation(['auth'])
  const navigate = useNavigate()
  const { user } = useAuthState()
  // True while this page is signing someone in: the page then leaves on its
  // own, once the new account has a name.
  const [busy, setBusy] = useState(false)
  // A verification link opened in a browser signed in to another account:
  // explain instead of bouncing to /app and dropping the link's message.
  const fromVerifyLink = !!verifyToken || !!verifyExpired
  useRedirectWhenAuthenticated(!fromVerifyLink && !busy, redirect)

  if (fromVerifyLink && user && !busy) return <OtherAccountCard email={user.email} />

  const isInviteFlow = redirect?.startsWith('/accept-invite/') ?? false
  const notices = [
    search.error && {
      tone: 'error' as const,
      text: t(SOCIAL_ERRORS[search.error] ?? 'auth:social.error'),
    },
    search.expired && { tone: 'info' as const, text: t('auth:signIn.sessionExpired') },
    verifyToken && { tone: 'info' as const, text: t('auth:signIn.verifyPending') },
    verifyExpired && { tone: 'info' as const, text: t('auth:signIn.verifyExpired') },
  ].filter((n) => !!n)

  return (
    <EmailSignIn
      title={
        search.mode === 'signup' ? t('auth:signIn.titleSignup') : t('auth:signIn.title')
      }
      description={
        isInviteFlow
          ? t('auth:signIn.descriptionInvite')
          : search.mode === 'signup'
            ? t('auth:signIn.descriptionSignup')
            : t('auth:signIn.description')
      }
      notice={notices.map((n) => (
        <Alert
          key={n.text}
          variant={n.tone === 'error' ? 'destructive' : 'default'}
          role={n.tone === 'error' ? 'alert' : 'status'}
        >
          <AlertDescription>{n.text}</AlertDescription>
        </Alert>
      ))}
      initialEmail={search.email}
      redirect={redirect}
      verifyToken={verifyToken}
      passwordFirst={fromVerifyLink}
      onBusyChange={setBusy}
      onDone={() => navigate({ href: redirect ?? '/app', replace: true })}
    />
  )
}

function OtherAccountCard({ email }: { email: string }) {
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const [signingOut, setSigningOut] = useState(false)
  return (
    <AuthShell title={t('signIn.title')}>
      <CardContent>
        <Alert role="status">
          <AlertDescription>
            <Trans t={t} i18nKey="signIn.verifyOtherAccount" values={{ email }} />
          </AlertDescription>
        </Alert>
      </CardContent>
      <CardFooter className="flex-col gap-3">
        <Button
          className={`w-full ${AUTH_CONTROL}`}
          disabled={signingOut}
          onClick={async () => {
            setSigningOut(true)
            await authClient.signOut()
            setSigningOut(false)
          }}
        >
          {signingOut && <Spinner />}
          {t('signIn.verifySignOut')}
        </Button>
        <Button
          variant="outline"
          className={`w-full ${AUTH_CONTROL}`}
          onClick={() => navigate({ to: '/app' })}
        >
          {t('signIn.verifyStay')}
        </Button>
      </CardFooter>
    </AuthShell>
  )
}
