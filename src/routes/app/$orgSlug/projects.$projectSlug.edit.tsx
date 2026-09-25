import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { publishBlockers } from '../../../../convex/lib/publishReadiness'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { cn } from '~/lib/utils'
import { StepBasics } from '~/components/projects/wizard/StepBasics'
import { StepCandidateForm } from '~/components/projects/wizard/StepCandidateForm'
import { StepCriteria } from '~/components/projects/wizard/StepCriteria'
import { StepQuestions } from '~/components/projects/wizard/StepQuestions'
import { StepReview } from '~/components/projects/wizard/StepReview'
import { AppNotFound, AppRouteError } from '~/components/app-shell/RouteFallbacks'

export const Route = createFileRoute('/app/$orgSlug/projects/$projectSlug/edit')(
  {
    component: ProjectWizardPage,
    errorComponent: AppRouteError,
    notFoundComponent: AppNotFound,
    head: () => ({
      meta: [
        {
          title: getI18n(getLocale()).getFixedT(null, 'projects')(
            'wizard.title',
          ),
        },
      ],
    }),
  },
)

const STEPS = ['basics', 'questions', 'criteria', 'candidate', 'review'] as const
type Step = (typeof STEPS)[number]

function ProjectWizardPage() {
  const { t } = useTranslation(['projects', 'common'])
  const { orgSlug, projectSlug } = Route.useParams()
  const navigate = useNavigate()
  const [step, setStep] = useState<Step>('basics')

  const org = useConvexQuery(api.organizations.bySlug, { slug: orgSlug })
  const data = useConvexQuery(
    api.projects.getBySlug,
    org ? { orgId: org._id, slug: projectSlug } : 'skip',
  )
  const publish = useConvexMutation(api.projects.publish)

  if (data === undefined) {
    return (
      <main className="flex-1 space-y-6 p-6">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-10 w-full max-w-2xl" />
        <Skeleton className="h-96 w-full rounded-lg" />
      </main>
    )
  }

  const { project, questions, criteria } = data
  const index = STEPS.indexOf(step)
  const canPublish = publishBlockers(questions, criteria).length === 0

  const finish = async () => {
    try {
      if (project.status === 'draft') {
        await publish({ projectId: project._id })
      }
      await navigate({
        to: '/app/$orgSlug/projects/$projectSlug',
        params: { orgSlug, projectSlug },
      })
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <main className="flex-1 space-y-6 p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {project.title}
          </h1>
          <p className="text-muted-foreground text-sm">
            {t('projects:wizard.title')}
          </p>
        </div>
        <Button variant="ghost" asChild>
          <Link
            to="/app/$orgSlug/projects/$projectSlug"
            params={{ orgSlug, projectSlug }}
          >
            {t('common:actions.close')}
          </Link>
        </Button>
      </div>

      {/* Steps are navigable in any order: editing an existing role is rarely
          linear, and forcing a sequence would make fixing one typo a five-click
          journey. */}
      <nav aria-label={t('projects:wizard.title')}>
        <ol className="flex flex-wrap gap-1">
          {STEPS.map((key, position) => {
            const active = key === step
            return (
              <li key={key}>
                <button
                  type="button"
                  onClick={() => setStep(key)}
                  aria-current={active ? 'step' : undefined}
                  className={cn(
                    'focus-visible:ring-ring flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                    active
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                  )}
                >
                  <span className="tabular-nums opacity-70">
                    {position + 1}
                  </span>
                  {t(`projects:wizard.steps.${key}`)}
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <div className="max-w-4xl">
        {step === 'basics' && <StepBasics project={project} />}
        {step === 'questions' && (
          <StepQuestions project={project} questions={questions} />
        )}
        {step === 'criteria' && (
          <StepCriteria project={project} criteria={criteria} />
        )}
        {step === 'candidate' && <StepCandidateForm project={project} />}
        {step === 'review' && (
          <StepReview
            project={project}
            questions={questions}
            criteria={criteria}
          />
        )}
      </div>

      <div className="flex max-w-4xl items-center justify-between gap-4 border-t pt-6">
        <Button
          variant="outline"
          disabled={index === 0}
          onClick={() => setStep(STEPS[Math.max(0, index - 1)])}
        >
          {t('projects:wizard.back')}
        </Button>

        {step === 'review' ? (
          <Button onClick={() => void finish()} disabled={!canPublish}>
            <Check className="size-4" />
            {project.status === 'draft'
              ? t('projects:detail.publish')
              : t('projects:wizard.finish')}
          </Button>
        ) : (
          <Button
            onClick={() => setStep(STEPS[Math.min(STEPS.length - 1, index + 1)])}
          >
            {t('projects:wizard.next')}
          </Button>
        )}
      </div>
    </main>
  )
}
