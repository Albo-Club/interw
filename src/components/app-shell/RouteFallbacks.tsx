import { useEffect } from 'react'
import { Link, useParams, useRouter } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { FileQuestion, TriangleAlert } from 'lucide-react'
import type { ErrorComponentProps } from '@tanstack/react-router'
import type { ReactNode } from 'react'

import { Button } from '~/components/ui/button'
import { convexErrorCode } from '~/lib/convex-errors'
import { Sentry } from '~/lib/sentry'

/**
 * Error and not-found screens for the routes under `/app/$orgSlug` (M1).
 *
 * The router-wide fallbacks fill the viewport and point at the marketing
 * homepage, and report everything to Sentry. Here they render inside the
 * app's own layout — the sidebar stays, so the recruiter is never stranded —
 * and lead back to the roles. A `not_found` from a Convex query (a mistyped
 * slug, a role deleted or moved out of reach) is an expected outcome, not a
 * fault: it gets the not-found screen and is never reported.
 */
export function AppRouteError({ error }: ErrorComponentProps) {
  const { t } = useTranslation('nav')
  const router = useRouter()
  const notFound = isNotFoundError(error)

  useEffect(() => {
    if (!notFound) Sentry.captureException(error)
  }, [error, notFound])

  if (notFound) return <AppNotFound />

  return (
    <Fallback
      icon={<TriangleAlert className="size-5" aria-hidden />}
      title={t('routeFallback.error.title')}
      body={t('routeFallback.error.body')}
    >
      <Button onClick={() => void router.invalidate()}>
        {t('routeFallback.error.retry')}
      </Button>
    </Fallback>
  )
}

export function AppNotFound() {
  const { t } = useTranslation('nav')
  return (
    <Fallback
      icon={<FileQuestion className="size-5" aria-hidden />}
      title={t('routeFallback.notFound.title')}
      body={t('routeFallback.notFound.body')}
    />
  )
}

export function isNotFoundError(error: unknown): boolean {
  return convexErrorCode(error) === 'not_found'
}

function Fallback({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode
  title: string
  body: string
  children?: ReactNode
}) {
  const { t } = useTranslation('nav')
  const { orgSlug } = useParams({ strict: false })
  return (
    <main className="flex flex-1 justify-center p-6 pt-16">
      <div className="max-w-md space-y-4">
        <div className="bg-muted text-muted-foreground flex size-10 items-center justify-center rounded-md">
          {icon}
        </div>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="text-muted-foreground text-sm">{body}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {children}
          <Button variant={children ? 'outline' : 'default'} asChild>
            {orgSlug ? (
              <Link to="/app/$orgSlug/projects" params={{ orgSlug }}>
                {t('routeFallback.backToRoles')}
              </Link>
            ) : (
              <Link to="/app">{t('routeFallback.backToApp')}</Link>
            )}
          </Button>
        </div>
      </div>
    </main>
  )
}
