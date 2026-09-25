import { useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { CheckCircle2 } from 'lucide-react'

import { api } from '../../../../convex/_generated/api'
import { Skeleton } from '~/components/ui/skeleton'
import { CandidateShell } from '~/components/candidate/CandidateShell'
import { useCandidateLanguage } from '~/components/candidate/useCandidateLanguage'
import { candidateHead } from '~/components/candidate/screenHead'

export const Route = createFileRoute('/s/$token/done')({
  component: InterviewDone,
  head: () => candidateHead('done'),
})

function InterviewDone() {
  const { t } = useTranslation(['interview', 'common'])
  const { token } = Route.useParams()
  const [now] = useState(() => Date.now())
  const data = useConvexQuery(api.candidate.landing, { token, now })
  const languageReady = useCandidateLanguage(data?.project.language)

  if (data === undefined || !languageReady) {
    return (
      <CandidateShell>
        <Skeleton className="h-40 w-full rounded-lg" />
      </CandidateShell>
    )
  }

  return (
    <CandidateShell
      organisationName={data.organisationName}
      logoUrl={data.organisationLogoUrl}
    >
      <div className="space-y-8">
        <div className="space-y-3">
          <CheckCircle2 className="text-success size-10" />
          <h1 className="text-3xl font-semibold tracking-tight">
            {t('interview:done.title')}
          </h1>
          <p className="text-muted-foreground text-lg leading-relaxed">
            {t('interview:done.body', { org: data.organisationName })}
          </p>
        </div>

        <section className="space-y-3">
          <h2 className="text-sm font-semibold tracking-wide uppercase">
            {t('interview:done.whatNext')}
          </h2>
          <ul className="text-muted-foreground list-disc space-y-2 pl-5 leading-relaxed">
            <li>
              {t('interview:done.nextSteps.review', {
                org: data.organisationName,
              })}
            </li>
            <li>
              {t('interview:done.nextSteps.contact', {
                email: data.session.candidateEmail,
              })}
            </li>
          </ul>
        </section>

        <div className="border-t pt-6">
          <Link
            to="/s/$token/privacy"
            params={{ token }}
            className="text-sm underline underline-offset-4"
          >
            {t('interview:done.privacy')}
          </Link>
        </div>
      </div>
    </CandidateShell>
  )
}
