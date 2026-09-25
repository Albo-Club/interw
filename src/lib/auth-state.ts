import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useConvexAuth } from 'convex/react'
import { authClient } from '~/lib/auth-client'

// Unified auth signal that prevents the "false unauthenticated" flash that
// briefly redirects to /login on hard refresh or new-tab navigation.
//
// `useConvexAuth()` reports `{ isLoading: false, isAuthenticated: false }`
// both when (a) the user is genuinely signed out AND (b) when the Convex
// client is mid-fetch of a fresh JWT after WebSocket re-open. Treating (b)
// like (a) causes the auth guard to redirect, then snap back once Convex
// catches up.
//
// Better Auth's `useSession()` reads from the BA cookieCache (~5min TTL)
// and resolves almost instantly. If BA reports a session, we know the user
// is authenticated even if Convex is still catching up.
//
// Use this hook in any route guard instead of consuming `useConvexAuth()`
// directly.
export function useAuthState() {
  const { isLoading: convexLoading, isAuthenticated: convexAuth } =
    useConvexAuth()
  const baSession = authClient.useSession()

  const baPending = baSession.isPending
  const hasBaUser = !!baSession.data?.user

  // Loading: either side hasn't decided yet, OR BA has a user but Convex
  // hasn't issued a token yet (the gap that causes the flash).
  const isLoading = convexLoading || baPending || (hasBaUser && !convexAuth)

  // Authenticated: both sides must agree. (Both true.)
  const isAuthenticated = convexAuth && hasBaUser

  // Signed out: BA confirms no session AND it's not still loading.
  const isSignedOut = !baPending && !hasBaUser

  return {
    isLoading,
    isAuthenticated,
    isSignedOut,
    user: baSession.data?.user ?? null,
  }
}

// Mirror of the `/app` guard for the *public* auth-entry pages (`/`, `/login`):
// send an already-authenticated visitor on — to `to` (a return URL already
// checked by `internalRedirectSearch`) or into the app — instead of showing
// them the landing/sign-in screen. Keys off the BA session alone (not Convex)
// so the redirect fires as soon as a session is confirmed; the `/app` guard
// then covers the Convex-JWT loading gap. `enabled: false` lets a page that
// has something to say to a signed-in visitor keep them — including a sign-in
// form with steps left after its own sign-in.
export function useRedirectWhenAuthenticated(enabled = true, to?: string) {
  const navigate = useNavigate()
  const { user } = useAuthState()

  useEffect(() => {
    if (enabled && user) navigate({ href: to ?? '/app', replace: true })
  }, [enabled, user, navigate, to])
}
