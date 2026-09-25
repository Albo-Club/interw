import { createAuthClient } from 'better-auth/react'
import { convexClient } from '@convex-dev/better-auth/client/plugins'
import { emailOTPClient } from 'better-auth/client/plugins'

import { rememberSignInMethod, rememberSignOut } from '~/lib/auth-memory'

// Every sign-in and sign-out goes through this client, whichever page calls
// it, so this is the one place that keeps `auth-memory` current.
const REMEMBERED: Array<[string, () => void]> = [
  ['/sign-in/email-otp', () => rememberSignInMethod('email')],
  ['/sign-in/email', () => rememberSignInMethod('password')],
  ['/sign-in/social', () => rememberSignInMethod('google')],
  ['/sign-out', rememberSignOut],
]

export const authClient = createAuthClient({
  plugins: [convexClient(), emailOTPClient()],
  fetchOptions: {
    onSuccess: ({ request }) => {
      const path = new URL(String(request.url), 'http://x').pathname
      REMEMBERED.find(([suffix]) => path.endsWith(suffix))?.[1]()
    },
  },
})
