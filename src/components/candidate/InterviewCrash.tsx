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
 * safe, and here is the button that puts you back where you were — because
 * `lastQuestionIndex` lives on the server and a reload resumes from it.
 */
export function InterviewCrash({ error }: ErrorComponentProps) {
  const { t } = useTranslation(['interview', 'common'])
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
        <Button size="lg" onClick={() => window.location.reload()}>
          {t('interview:run.crash.reload')}
        </Button>
      </div>
    </CandidateShell>
  )
}
