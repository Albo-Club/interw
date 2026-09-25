import { useEffect, useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { pendingCodeRedirect } from '~/lib/auth-memory'
import { useAuthState, useRedirectWhenAuthenticated } from '~/lib/auth-state'
import { internalRedirectSearch } from '~/lib/safe-redirect'
import { AUTH_CONTROL, AuthShell } from '~/components/auth/auth-shell'
import { EmailSignIn } from '~/components/auth/email-sign-in'
import { Button } from '~/components/ui/button'
import { CardFooter } from '~/components/ui/card'
import { Skeleton } from '~/components/ui/skeleton'

// The button in the sign-in code email. The address and the code travel in
// the fragment, which the browser never sends to a server, and nothing signs
// in until the person presses Confirm: a mail scanner that opens links does
// not spend the code. See KNOWN_ISSUES.md § "Email sign-in: one code, typed or
// confirmed".
export const Route = createFileRoute('/login_/code')({
  component: CodeLinkPage,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'auth')('code.metaTitle'),
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
})

const fragmentSchema = z.object({
  email: z.email(),
  code: z.string().regex(/^\d{6}$/),
})

type Parsed = { ok: true; email: string; code: string } | { ok: false }

function CodeLinkPage() {
  const { t } = useTranslation('auth')
  const navigate = useNavigate()
  const { user } = useAuthState()
  // `undefined` until read: the fragment only exists in the browser.
  const [parsed, setParsed] = useState<Parsed>()
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const fields = Object.fromEntries(
      new URLSearchParams(window.location.hash.slice(1)),
    )
    // Keep the code out of the history and of anything that reads the URL.
    window.history.replaceState(
      window.history.state,
      '',
      window.location.pathname,
    )
    const result = fragmentSchema.safeParse(fields)
    setParsed(
      result.success
        ? { ok: true, email: result.data.email.toLowerCase(), code: result.data.code }
        : { ok: false },
    )
  }, [])

  const email = parsed?.ok ? parsed.email : undefined
  // Same browser that asked for the code: back to where it was going.
  const redirect = email
    ? internalRedirectSearch.parse(pendingCodeRedirect(email))
    : undefined
  // Already in, as this very address: nothing to confirm.
  useRedirectWhenAuthenticated(
    !busy && !!email && user?.email.toLowerCase() === email,
    redirect,
  )

  if (!parsed)
    return (
      <AuthShell title={t('code.linkTitle')}>
        <CardFooter>
          <Skeleton className={`w-full ${AUTH_CONTROL}`} />
        </CardFooter>
      </AuthShell>
    )

  if (!parsed.ok)
    return (
      <AuthShell title={t('code.linkTitle')} description={t('code.incompleteLink')}>
        <CardFooter>
          <Button asChild className={`w-full ${AUTH_CONTROL}`}>
            <Link to="/login">{t('backToSignIn')}</Link>
          </Button>
        </CardFooter>
      </AuthShell>
    )

  return (
    <EmailSignIn
      title={t('signIn.title')}
      description={t('signIn.description')}
      link={parsed}
      redirect={redirect}
      onBusyChange={setBusy}
      onDone={() => navigate({ href: redirect ?? '/app', replace: true })}
    />
  )
}
