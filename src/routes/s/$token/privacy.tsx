import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useConvexAction, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../../../../convex/_generated/api'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription } from '~/components/ui/alert'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog'
import { CandidateNotice } from '~/components/candidate/CandidateNotice'
import {
  CandidateShell,
  candidateAction,
} from '~/components/candidate/CandidateShell'

export const Route = createFileRoute('/s/$token/privacy')({
  component: CandidatePrivacy,
})

function CandidatePrivacy() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const [now] = useState(() => Date.now())
  const [erasure, setErasure] = useState<'idle' | 'deleting' | 'deleted'>(
    'idle',
  )
  // Unsubscribed the moment deletion starts. The summary is a reactive query
  // on the session being deleted: it throws `not_found` as soon as the rows
  // go — before the action even returns — and the candidate saw a crash
  // instead of the confirmation of their erasure.
  const summary = useConvexQuery(
    api.candidate.privacySummary,
    erasure === 'idle' ? { token, now } : 'skip',
  )
  const deleteMyData = useConvexAction(api.candidate.deleteMyData)

  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (erasure !== 'idle') {
    return (
      <CandidateNotice
        title={t(
          erasure === 'deleted'
            ? 'interview:privacy.deleted.title'
            : 'interview:privacy.deleting',
        )}
        body={erasure === 'deleted' ? t('interview:privacy.deleted.body') : ''}
      />
    )
  }

  if (summary === undefined) {
    return (
      <CandidateShell>
        <Skeleton className="h-64 w-full rounded-lg" />
      </CandidateShell>
    )
  }

  const org = summary.organisationName

  const remove = async () => {
    setConfirming(false)
    setError(null)
    setErasure('deleting')
    try {
      await deleteMyData({ token })
      setErasure('deleted')
    } catch (cause) {
      setErasure('idle')
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <CandidateShell organisationName={org}>
      <div className="space-y-8">
        <header className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('interview:privacy.title')}
          </h1>
          <p className="text-muted-foreground leading-relaxed">
            {t('interview:privacy.subtitle', { org })}
          </p>
        </header>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            {t('interview:privacy.held')}
          </h2>
          <ul className="text-muted-foreground list-disc space-y-2 pl-5 leading-relaxed">
            <li>{t('interview:privacy.items.identity', { org })}</li>
            {summary.answerCount > 0 && (
              <li>{t('interview:privacy.items.recordings')}</li>
            )}
            {summary.hasTranscript && (
              <li>{t('interview:privacy.items.transcript')}</li>
            )}
            {summary.hasAnalysis && (
              <li>{t('interview:privacy.items.analysis')}</li>
            )}
            {summary.hasDocuments && (
              <li>{t('interview:privacy.items.documents')}</li>
            )}
          </ul>
        </section>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            {t('interview:privacy.rights')}
          </h2>
          <p className="text-muted-foreground max-w-prose leading-relaxed">
            {t('interview:privacy.rightsBody', { org })}
          </p>
        </section>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="border-t pt-6">
          <Button
            variant="destructive"
            size="lg"
            className={candidateAction}
            onClick={() => setConfirming(true)}
          >
            {t('interview:privacy.delete')}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('interview:privacy.deleteConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('interview:privacy.deleteConfirm.body', { org })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void remove()}>
              {t('interview:privacy.deleteConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </CandidateShell>
  )
}
