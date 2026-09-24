import { useEffect } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { CandidateNotice } from './CandidateNotice'
import { CandidateShell, candidateAction } from './CandidateShell'
import { linkStateFromError } from './errorState'
import type { ErrorComponentProps } from '@tanstack/react-router'

import { Button } from '~/components/ui/button'
import { Sentry } from '~/lib/sentry'

/**
 * What a candidate sees when anything under `/s/$token` throws.
 *
 * Two different things arrive here, and they must not look alike. A link that
 * is unknown, expired, closed, cancelled or already used is a state, reported
 * by the server as a `ConvexError`: it gets the candidate copy for that state
 * and a real next step, and it is not a crash to report. Anything else is a
 * crash: it says the two things that matter — your saved answers are safe,
 * here is the way back, since they live on the server — and is reported.
 *
 * Two ways out of a crash, on purpose. Reloading fixes a transient failure.
 * Going back to the start fixes the case a reload cannot: arriving here in a
 * state the interview route refuses, such as before consent was given.
 */
export function CandidateError({ error }: ErrorComponentProps) {
  const { t } = useTranslation(['interview', 'common'])
  const params = useParams({ strict: false })
  const token = typeof params.token === 'string' ? params.token : null
  const state = linkStateFromError(error)

  // After render, not during it: a capture in the render body re-sent the
  // event on every re-render.
  useEffect(() => {
    if (state === null) Sentry.captureException(error)
  }, [error, state])

  if (state !== null) {
    return (
      <CandidateNotice
        title={t(`interview:state.${state}.title`)}
        body={t(`interview:state.${state}.body`)}
      />
    )
  }

  return (
    <CandidateShell>
      <div className="space-y-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('interview:run.crash.title')}
        </h1>
        <p className="text-muted-foreground max-w-prose leading-relaxed">
          {t('interview:run.crash.body')}
        </p>
        <div className="flex flex-wrap gap-3">
          <Button
            size="lg"
            className={candidateAction}
            onClick={() => window.location.reload()}
          >
            {t('interview:run.crash.reload')}
          </Button>
          {token && (
            <Button size="lg" variant="outline" className={candidateAction} asChild>
              <Link to="/s/$token" params={{ token }}>
                {t('interview:run.crash.restart')}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </CandidateShell>
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
