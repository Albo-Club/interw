import { Link, useParams } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'
import { CandidateShell } from './CandidateShell'
import type { ErrorComponentProps } from '@tanstack/react-router'

import { Button } from '~/components/ui/button'
import { Sentry } from '~/lib/sentry'

/**
 * The screen a candidate sees if the interview page throws mid-interview.
 *
 * The previous build had no boundary here, so a render error left a candidate
 * staring at a white page in the middle of their interview and lost the
 * recordings. This says the two things that matter — your saved answers are
 * safe, and here is the way back — because `lastQuestionIndex` lives on the
 * server and both routes resume from it.
 *
 * Two ways out, on purpose. Reloading fixes a transient failure. Going back to
 * the start fixes the case a reload cannot: arriving here in a state the
 * interview route refuses, such as before consent was given.
 */
export function InterviewCrash({ error }: ErrorComponentProps) {
  const { t } = useTranslation(['interview', 'common'])
  const params = useParams({ strict: false })
  const token = typeof params.token === 'string' ? params.token : null

  Sentry.captureException(error)

  return (
    <CandidateShell>
      <div className="space-y-5 py-10">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('interview:run.crash.title')}
        </h1>
        <p className="text-muted-foreground max-w-prose leading-relaxed">
          {t('interview:run.crash.body', { index: '…' })}
        </p>
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
      </div>
    </CandidateShell>
  )
}
