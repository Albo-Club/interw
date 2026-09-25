import { useEffect, useMemo, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Check, Clock, MessageSquare, Mic, Monitor, Video } from 'lucide-react'

import { api } from '../../../../convex/_generated/api'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Label } from '~/components/ui/label'
import { Checkbox } from '~/components/ui/checkbox'
import { Skeleton } from '~/components/ui/skeleton'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { CandidateNotice } from '~/components/candidate/CandidateNotice'
import { CandidateShell } from '~/components/candidate/CandidateShell'
import { DocumentUploadField } from '~/components/candidate/DocumentUploadField'
import { useCandidateLanguage } from '~/components/candidate/useCandidateLanguage'
import { candidateHead } from '~/components/candidate/screenHead'

export const Route = createFileRoute('/s/$token/')({
  component: CandidateWelcome,
  head: () => candidateHead('welcome'),
})

function CandidateWelcome() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const navigate = useNavigate()

  // The clock is passed in rather than read inside the query: a Convex query
  // is not re-run as time passes, so a query reading `Date.now()` would cache
  // "still open" past the role's expiry. Refreshed every 30s so a page left
  // open notices the deadline.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const data = useConvexQuery(api.candidate.landing, { token, now })
  const languageReady = useCandidateLanguage(data?.project.language)
  const updateProfile = useConvexMutation(api.candidate.updateProfile)
  const acceptConsent = useConvexMutation(api.candidate.acceptConsent)

  const [phone, setPhone] = useState('')
  const [linkedin, setLinkedin] = useState('')
  const [consented, setConsented] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const blocked = useMemo(() => {
    if (data === undefined) return null
    const { state } = data.gate
    return state === 'ready' || state === 'resumable' ? null : state
  }, [data])

  if (data === undefined || !languageReady) {
    return (
      <CandidateShell>
        <div className="space-y-6">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-5 w-full max-w-md" />
          <Skeleton className="h-40 w-full rounded-lg" />
          <Skeleton className="h-11 w-48" />
        </div>
      </CandidateShell>
    )
  }

  if (blocked) {
    return (
      <CandidateNotice
        organisationName={data.organisationName}
        title={t(`interview:state.${blocked}.title`)}
        body={t(`interview:state.${blocked}.body`, {
          org: data.organisationName,
        })}
      />
    )
  }

  const { project, session, gate } = data
  const fields = project.candidateFields
  const resuming = gate.state === 'resumable'

  const proceed = async () => {
    setSubmitting(true)
    setError(null)
    try {
      if (fields.phone.enabled || fields.linkedin.enabled) {
        await updateProfile({
          token,
          ...(fields.phone.enabled ? { phone } : {}),
          ...(fields.linkedin.enabled ? { linkedin } : {}),
        })
      }
      if (gate.needsConsent) await acceptConsent({ token })
      await navigate({ to: '/s/$token/check', params: { token } })
    } catch (cause) {
      const { key, fallbackKey } = errorMessageKey(cause, 'interview')
      setError(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setSubmitting(false)
    }
  }

  const missingRequired =
    (fields.cv.enabled && fields.cv.required && !session.hasCv) ||
    (fields.coverLetter.enabled &&
      fields.coverLetter.required &&
      !session.hasCoverLetter) ||
    (fields.phone.enabled && fields.phone.required && phone.trim() === '') ||
    (fields.linkedin.enabled &&
      fields.linkedin.required &&
      linkedin.trim() === '')

  const canProceed =
    !submitting && !missingRequired && (consented || !gate.needsConsent)

  return (
    <CandidateShell
      organisationName={data.organisationName}
      logoUrl={data.organisationLogoUrl}
      privacyToken={token}
    >
      <div className="space-y-10">
        <header className="space-y-3">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t('interview:welcome.greeting', { name: session.candidateName })}
          </h1>
          <p className="text-muted-foreground text-lg leading-relaxed">
            {project.jobTitle
              ? t('interview:welcome.invitedBy', {
                  org: data.organisationName,
                  jobTitle: project.jobTitle,
                })
              : t('interview:welcome.invitedByNoRole', {
                  org: data.organisationName,
                })}
          </p>
        </header>

        {resuming && (
          <Alert>
            <AlertDescription>
              {t('interview:welcome.resumeHint', {
                index: gate.resumeAtIndex + 1,
              })}
            </AlertDescription>
          </Alert>
        )}

        <section className="space-y-4">
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            {t('interview:welcome.howItWorks')}
          </h2>
          <ul className="space-y-3">
            <Point icon={<MessageSquare className="size-4" />}>
              {t('interview:welcome.steps.questions', {
                count: project.questionCount,
              })}
            </Point>
            <Point icon={<Video className="size-4" />}>
              {t('interview:welcome.steps.record')}
            </Point>
            <Point icon={<Clock className="size-4" />}>
              {t('interview:welcome.steps.duration', {
                count: project.maxDurationMinutes,
              })}
            </Point>
            <Point icon={<Check className="size-4" />}>
              {t('interview:welcome.steps.alone')}
            </Point>
          </ul>
        </section>

        <section className="space-y-4">
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            {t('interview:welcome.whatYouNeed')}
          </h2>
          <ul className="space-y-3">
            <Point icon={<Video className="size-4" />}>
              {t('interview:welcome.needs.camera')}
            </Point>
            <Point icon={<Mic className="size-4" />}>
              {t('interview:welcome.needs.quiet')}
            </Point>
            <Point icon={<Monitor className="size-4" />}>
              {t('interview:welcome.needs.browser')}
            </Point>
          </ul>
        </section>

        {(fields.phone.enabled ||
          fields.linkedin.enabled ||
          fields.cv.enabled ||
          fields.coverLetter.enabled) && (
          <section className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold tracking-wide uppercase">
                {t('interview:welcome.yourDetails')}
              </h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('interview:welcome.detailsHint', {
                  org: data.organisationName,
                })}
              </p>
            </div>

            <div className="space-y-5">
              {fields.phone.enabled && (
                <div className="space-y-2">
                  <Label htmlFor="candidate-phone">
                    {t('interview:welcome.fields.phone')}
                    {fields.phone.required && (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {t('interview:welcome.fields.required')}
                      </span>
                    )}
                  </Label>
                  <Input
                    id="candidate-phone"
                    type="tel"
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                  />
                </div>
              )}

              {fields.linkedin.enabled && (
                <div className="space-y-2">
                  <Label htmlFor="candidate-linkedin">
                    {t('interview:welcome.fields.linkedin')}
                    {fields.linkedin.required && (
                      <span className="text-muted-foreground ml-2 text-xs font-normal">
                        {t('interview:welcome.fields.required')}
                      </span>
                    )}
                  </Label>
                  <Input
                    id="candidate-linkedin"
                    type="url"
                    inputMode="url"
                    placeholder="https://www.linkedin.com/in/…"
                    value={linkedin}
                    onChange={(event) => setLinkedin(event.target.value)}
                  />
                </div>
              )}

              {fields.cv.enabled && (
                <DocumentUploadField
                  token={token}
                  kind="cv"
                  label={t('interview:welcome.fields.cv')}
                  required={fields.cv.required}
                  uploaded={session.hasCv}
                  onUploaded={() => undefined}
                />
              )}

              {fields.coverLetter.enabled && (
                <DocumentUploadField
                  token={token}
                  kind="cover"
                  label={t('interview:welcome.fields.coverLetter')}
                  required={fields.coverLetter.required}
                  uploaded={session.hasCoverLetter}
                  onUploaded={() => undefined}
                />
              )}
            </div>
          </section>
        )}

        {gate.needsConsent && (
          <section className="space-y-4 rounded-lg border p-5">
            <div>
              <h2 className="font-semibold">{t('interview:consent.title')}</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                {t('interview:consent.body')}
              </p>
            </div>
            <ul className="text-muted-foreground list-disc space-y-2 pl-5 text-sm leading-relaxed">
              <li>{t('interview:consent.points.recording')}</li>
              <li>
                {t('interview:consent.points.who', {
                  org: data.organisationName,
                })}
              </li>
              <li>{t('interview:consent.points.ai')}</li>
              <li>
                {t('interview:consent.points.retention', {
                  org: data.organisationName,
                })}
              </li>
            </ul>
            <div className="flex items-start gap-3">
              <Checkbox
                id="consent"
                checked={consented}
                onCheckedChange={(checked) => setConsented(checked === true)}
                className="mt-0.5"
              />
              <Label
                htmlFor="consent"
                className="cursor-pointer leading-relaxed font-normal"
              >
                {t('interview:consent.accept')}
              </Label>
            </div>
            <p className="text-muted-foreground text-xs">
              {t('interview:consent.acceptHint')}
            </p>
          </section>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {/* One primary action, always visible without scrolling past it. */}
        <div className="flex flex-col gap-3 border-t pt-6">
          <Button
            size="lg"
            className="w-full sm:w-auto sm:self-start"
            disabled={!canProceed}
            onClick={() => void proceed()}
          >
            {resuming
              ? t('interview:welcome.resume')
              : gate.needsConsent
                ? t('interview:consent.continue')
                : t('interview:welcome.start')}
          </Button>
        </div>
      </div>
    </CandidateShell>
  )
}

function Point({
  icon,
  children,
}: {
  icon: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <li className="flex items-start gap-3">
      <span className="text-muted-foreground mt-0.5 shrink-0">{icon}</span>
      <span className="leading-relaxed">{children}</span>
    </li>
  )
}
