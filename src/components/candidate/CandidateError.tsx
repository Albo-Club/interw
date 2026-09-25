import { useEffect } from 'react'
import { Link, Navigate, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { CandidateNotice } from './CandidateNotice'
import { linkStateFromError } from './errorState'
import type { ErrorComponentProps } from '@tanstack/react-router'

import { Button } from '~/components/ui/button'
import { convexErrorCode } from '~/lib/convex-errors'
import { Sentry } from '~/lib/sentry'

/**
 * What a candidate sees when anything under `/s/$token` throws.
 *
 * Two different things arrive here, and they must not look alike. A link that
 * is unknown, expired, closed, cancelled or already used is a state, reported
 * by the server as a `ConvexError`: it gets the candidate copy for that state
 * and is not a crash to report. Anything else is a crash: it says the two
 * things that matter — your saved answers are safe, here is the way back,
 * since they live on the server — and is reported.
 *
 * Two ways out of a crash, on purpose. Reloading fixes a transient failure;
 * going back to the start fixes what a reload cannot.
 */
export function CandidateError({ error }: ErrorComponentProps) {
  const { t } = useTranslation(['interview', 'common'])
  // Only a session route's token is a session token: `/apply/$applyToken`
  // uses this screen too, and its token must not become a `/s/` link.
  const token =
    useParams({ from: '/s/$token', shouldThrow: false })?.token ?? null
  const state = linkStateFromError(error)
  // Opening the interview before agreeing to be recorded: the consent is on
  // the welcome page, so that is where the candidate belongs.
  const needsConsent = convexErrorCode(error) === 'consent_required'

  // After render, not during it: a capture in the render body re-sent the
  // event on every re-render.
  useEffect(() => {
    if (state === null && !needsConsent) Sentry.captureException(error)
  }, [error, state, needsConsent])

  if (needsConsent && token) {
    return <Navigate to="/s/$token" params={{ token }} replace />
  }

  if (state !== null) {
    return (
      <CandidateNotice
        title={t(`interview:state.${state}.title`)}
        body={t(`interview:state.${state}.body`)}
      />
    )
  }

  return (
    <CandidateNotice
      title={t('interview:run.crash.title')}
      body={t('interview:run.crash.body')}
      action={
        <div className="flex flex-wrap gap-3">
          <Button size="lg" onClick={() => window.location.reload()}>
            {t('interview:run.crash.reload')}
          </Button>
          {token && (
            <Button size="lg" variant="outline" asChild>
              <Link to="/s/$token" params={{ token }}>
                {t('interview:run.crash.restart')}
              </Link>
            </Button>
          )}
        </div>
      }
    />
  )
}

/** A path under `/s/$token` that does not exist reads as a link that does not work. */
export function CandidateNotFound() {
  const { t } = useTranslation('interview')
  return (
    <CandidateNotice
      title={t('state.notFound.title')}
      body={t('state.notFound.body')}
    />
  )
}
