import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { authClient } from '~/lib/auth-client'
import { Button } from '~/components/ui/button'
import { Spinner } from '~/components/ui/spinner'

/**
 * Sign out, then sign in and come back to `returnTo`. For the Better Auth
 * endpoints that want a recent sign-in, and for a link that must be opened
 * signed in to a specific account. Signing out first matters: `/login`
 * sends anyone already signed in straight to `/app`.
 */
export function SignInAgainButton({
  returnTo,
  children,
}: {
  returnTo: string
  children: ReactNode
}) {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await authClient.signOut()
        await navigate({ to: '/login', search: { redirect: returnTo } })
      }}
    >
      {busy && <Spinner />}
      {children}
    </Button>
  )
}
