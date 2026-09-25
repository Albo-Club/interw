import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { internalRedirectSearch } from '~/lib/safe-redirect'

// Signing up and signing in are one flow (an email code creates the account on
// first use). The address stays for the links already out there.
export const Route = createFileRoute('/register')({
  validateSearch: z.object({ redirect: internalRedirectSearch }),
  beforeLoad: ({ search }) => {
    throw redirect({
      to: '/login',
      search: { mode: 'signup', redirect: search.redirect },
      replace: true,
    })
  },
})
