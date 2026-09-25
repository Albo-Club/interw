import { useEffect, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'

import { api } from '../../convex/_generated/api'
import type { FormEvent } from 'react'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription } from '~/components/ui/alert'
import {
  CandidateError,
  CandidateNotFound,
} from '~/components/candidate/CandidateError'
import { CandidateNotice } from '~/components/candidate/CandidateNotice'
import { CandidateShell } from '~/components/candidate/CandidateShell'
import { useCandidateLanguage } from '~/components/candidate/useCandidateLanguage'
import { candidateHead } from '~/components/candidate/screenHead'

/**
 * A role's public link. The candidate says who they are, gets a session of
 * their own, and continues on `/s/<token>` exactly as if they had been
 * invited. Part of the candidate surface: same bundle rule, same `noindex`.
 */
export const Route = createFileRoute('/apply/$applyToken')({
  component: ApplyPage,
  errorComponent: CandidateError,
  notFoundComponent: CandidateNotFound,
  head: () => {
    const { meta } = candidateHead('apply')
    return {
      meta: [
        ...meta,
        { name: 'robots', content: 'noindex, nofollow' },
        { name: 'referrer', content: 'no-referrer' },
      ],
    }
  },
})

function ApplyPage() {
  const { t } = useTranslation(['interview'])
  const { applyToken } = Route.useParams()
  const navigate = useNavigate()

  // Passed in rather than read by the query, as on `/s/$token`: a page left
  // open notices the deadline.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const data = useConvexQuery(api.apply.landing, { token: applyToken, now })
  const languageReady = useCandidateLanguage(data?.language)
  const start = useConvexMutation(api.apply.start)

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (data === undefined || !languageReady) {
    return (
      <CandidateShell>
        <div className="space-y-6">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-5 w-full max-w-md" />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      </CandidateShell>
    )
  }

  if (data.state !== 'ready') {
    return (
      <CandidateNotice
        organisationName={data.organisationName}
        title={t(`interview:state.${data.state}.title`)}
        body={t(`interview:apply.${data.state}`)}
      />
    )
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { sessionToken } = await start({ token: applyToken, name, email })
      await navigate({ to: '/s/$token', params: { token: sessionToken } })
    } catch (cause) {
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
      setSubmitting(false)
    }
  }

  return (
    <CandidateShell organisationName={data.organisationName}>
      <form className="space-y-8" onSubmit={submit}>
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {data.jobTitle
              ? t('interview:apply.title', { jobTitle: data.jobTitle })
              : t('interview:apply.titleNoRole', {
                  org: data.organisationName,
                })}
          </h1>
          <p className="text-muted-foreground text-lg leading-relaxed">
            {t('interview:apply.intro', {
              org: data.organisationName,
              count: data.maxInterviewMinutes,
            })}
          </p>
        </header>

        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="apply-name">{t('interview:apply.name')}</Label>
            <Input
              id="apply-name"
              autoComplete="name"
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="apply-email">{t('interview:apply.email')}</Label>
            <Input
              id="apply-email"
              type="email"
              autoComplete="email"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
            <p className="text-muted-foreground text-sm">
              {t('interview:apply.emailHint', { org: data.organisationName })}
            </p>
          </div>
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <Button type="submit" size="lg" disabled={submitting}>
          {submitting
            ? t('interview:apply.submitting')
            : t('interview:apply.submit')}
        </Button>
      </form>
    </CandidateShell>
  )
}
