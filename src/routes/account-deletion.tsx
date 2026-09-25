import { Link, createFileRoute } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { z } from 'zod'

import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { internalRedirectSearch } from '~/lib/safe-redirect'
import { Button } from '~/components/ui/button'
import { CardContent } from '~/components/ui/card'
import { AuthShell } from '~/components/auth/auth-shell'
import { SignInAgainButton } from '~/components/auth/sign-in-again-button'

// Where every account-deletion link lands, whatever happened to it — see
// `accountLifecycle` in convex/lib/accountLifecycle.ts. Left to Better Auth,
// all but the success case answered with raw JSON.
const searchSchema = z.object({
  status: z
    .enum(['deleted', 'signin', 'invalid', 'blocked'])
    .catch('invalid'),
  // The deletion link to return to once signed in. Reaches `/login`'s
  // redirect, so internal paths only.
  next: internalRedirectSearch,
})

export const Route = createFileRoute('/account-deletion')({
  component: AccountDeletionPage,
  validateSearch: searchSchema,
  head: () => ({
    meta: [
      {
        title: getI18n(getLocale()).getFixedT(null, 'account')(
          'deletion.metaTitle',
        ),
      },
      { name: 'robots', content: 'noindex, nofollow' },
    ],
  }),
})

function AccountDeletionPage() {
  const { t } = useTranslation('account')
  const { status, next } = Route.useSearch()

  return (
    <AuthShell
      title={t(`deletion.${status}.title`)}
      description={t(`deletion.${status}.body`)}
    >
      <CardContent className="flex justify-center">
        {status === 'deleted' ? (
          <Button asChild variant="outline">
            <Link to="/">{t('deletion.home')}</Link>
          </Button>
        ) : status === 'signin' && next ? (
          <SignInAgainButton returnTo={next}>
            {t('deletion.signin.action')}
          </SignInAgainButton>
        ) : (
          <Button asChild variant="outline">
            <Link to="/app/me" search={{ tab: 'security' }}>
              {t('deletion.profile')}
            </Link>
          </Button>
        )}
      </CardContent>
    </AuthShell>
  )
}
