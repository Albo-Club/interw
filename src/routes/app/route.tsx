import { useEffect } from 'react'
import {
  Outlet,
  createFileRoute,
  useLocation,
  useNavigate,
} from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { api } from '../../../convex/_generated/api'
import { AppShellSkeleton } from '~/components/app-shell/AppShellSkeleton'
import { useAuthState } from '~/lib/auth-state'
import { rememberSessionActive, takeLostSession } from '~/lib/auth-memory'

export const Route = createFileRoute('/app')({
  component: AppLayout,
})

function AppLayout() {
  const navigate = useNavigate()
  const { href } = useLocation()
  const { isLoading, isAuthenticated, isSignedOut } = useAuthState()
  const me = useConvexQuery(
    api.users.me,
    isAuthenticated ? {} : 'skip',
  )
  const provisionMe = useConvexMutation(api.users.provisionMe)

  useEffect(() => {
    // Only redirect when BA confirms no session. Don't redirect on the
    // transient `convexAuth=false while BA session loading` state — that
    // caused tab-A→tab-B and hard-refresh logouts in dev.
    // Back to this very page once signed in, with a word of explanation when
    // this browser had a session it never signed out of.
    if (isSignedOut) {
      navigate({
        to: '/login',
        search: {
          redirect: href === '/app' ? undefined : href,
          expired: takeLostSession() ? 1 : undefined,
        },
        replace: true,
      })
    }
  }, [isSignedOut, navigate, href])

  useEffect(() => {
    if (isAuthenticated) rememberSessionActive()
  }, [isAuthenticated])

  useEffect(() => {
    if (me?.kind === 'unprovisioned') {
      void provisionMe()
    }
  }, [me?.kind, provisionMe])

  if (isLoading || !isAuthenticated || !me || me.kind !== 'ready') {
    return <AppShellSkeleton />
  }

  return <Outlet />
}
