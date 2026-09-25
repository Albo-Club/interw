import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { useConvexMutation, useConvexQuery } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Check } from 'lucide-react'
import { toast } from 'sonner'
import { z } from 'zod'

import { api } from '../../../../convex/_generated/api'
import { publishBlockers } from '../../../../convex/lib/publishReadiness'
import type { PublishBlocker } from '../../../../convex/lib/publishReadiness'
import type { WizardStep } from '~/components/projects/wizard/steps'
import { getI18n } from '~/lib/i18n'
import { getLocale } from '~/lib/locale'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Skeleton } from '~/components/ui/skeleton'
import { cn } from '~/lib/utils'
import { StepCandidate } from '~/components/projects/wizard/StepCandidate'
import { StepCriteria } from '~/components/projects/wizard/StepCriteria'
import { StepQuestions } from '~/components/projects/wizard/StepQuestions'
import { StepPublish } from '~/components/projects/wizard/StepPublish'
import {
  WIZARD_STEPS,
  stepOfBlocker,
} from '~/components/projects/wizard/steps'
import { AppNotFound, AppRouteError } from '~/components/app-shell/RouteFallbacks'

export const Route = createFileRoute('/app/$orgSlug/projects/$projectSlug/edit')(
  {
    component: ProjectWizardPage,
    errorComponent: AppRouteError,
    notFoundComponent: AppNotFound,
    // The step lives in the URL so a reload, the back button and a shared
    // link all land where the recruiter was.
    validateSearch: z.object({
      step: z.enum(WIZARD_STEPS).optional().catch(undefined),
    }),
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

function ProjectWizardPage() {
  const { t } = useTranslation(['projects', 'common'])
  const { orgSlug, projectSlug } = Route.useParams()
  const step = Route.useSearch().step ?? 'questions'
  const navigate = useNavigate({ from: Route.fullPath })
  const [publishing, setPublishing] = useState(false)

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
  const index = WIZARD_STEPS.indexOf(step)
  const blockers = publishBlockers(questions, criteria)
  const nextStep = WIZARD_STEPS[index + 1] as WizardStep | undefined
  const goTo = (target: WizardStep) =>
    void navigate({ search: { step: target } })

  const finish = async () => {
    setPublishing(true)
    try {
      if (project.status === 'draft') {
        await publish({ projectId: project._id })
      }
      await navigate({
        to: '/app/$orgSlug/projects/$projectSlug',
        params: { orgSlug, projectSlug },
        search: {},
      })
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    } finally {
      setPublishing(false)
    }
  }

  return (
    <main className="flex-1 p-6 pb-0">
      <div className="mx-auto max-w-4xl space-y-8">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="truncate text-2xl font-semibold tracking-tight">
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
            linear, and forcing a sequence would make fixing one typo a
            four-click journey. Each one says whether it still blocks
            publishing, so the order is a suggestion, not a gate. */}
        <nav aria-label={t('projects:wizard.title')}>
          <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {WIZARD_STEPS.map((key, position) => {
              const active = key === step
              const status = stepStatus(key, blockers)
              return (
                <li key={key}>
                  <Link
                    from={Route.fullPath}
                    search={{ step: key }}
                    aria-current={active ? 'step' : undefined}
                    className={cn(
                      'focus-visible:ring-ring flex h-full items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none',
                      active
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums',
                        active && 'border-primary bg-primary text-primary-foreground',
                        !active &&
                          status === 'done' &&
                          'border-success/40 bg-success-subtle text-success-strong',
                      )}
                    >
                      {status === 'done' && !active ? (
                        <Check className="size-3.5" />
                      ) : (
                        position + 1
                      )}
                    </span>
                    <span className="min-w-0 font-medium">
                      {t(`projects:wizard.steps.${key}`)}
                    </span>
                    {status === 'todo' && (
                      <span
                        aria-hidden
                        className="bg-warning-strong ml-auto size-2 shrink-0 rounded-full"
                      />
                    )}
                    {status && (
                      <span className="sr-only">
                        {t(
                          status === 'done'
                            ? 'projects:wizard.stepDone'
                            : 'projects:wizard.stepTodo',
                        )}
                      </span>
                    )}
                  </Link>
                </li>
              )
            })}
          </ol>
        </nav>

        <div>
          {step === 'questions' && (
            <StepQuestions project={project} questions={questions} />
          )}
          {step === 'criteria' && (
            <StepCriteria project={project} criteria={criteria} />
          )}
          {step === 'candidate' && <StepCandidate project={project} />}
          {step === 'publish' && org && (
            <StepPublish
              orgId={org._id}
              orgSlug={orgSlug}
              project={project}
              questions={questions}
              criteria={criteria}
              blockers={blockers}
              onGoTo={goTo}
            />
          )}
        </div>
      </div>

      {/* Sticky, so "what next" is always one glance away on a long list of
          questions. Fields save on blur; saying so replaces a Save button
          that would do nothing. */}
      <div className="bg-background/95 sticky bottom-0 -mx-6 mt-8 border-t px-6 py-4 backdrop-blur">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4">
          <Button
            variant="outline"
            disabled={index === 0}
            onClick={() => goTo(WIZARD_STEPS[Math.max(0, index - 1)])}
          >
            {t('projects:wizard.back')}
          </Button>

          <p className="text-muted-foreground hidden text-xs sm:block">
            {t('projects:wizard.autosave')}
          </p>

          {nextStep ? (
            <Button onClick={() => goTo(nextStep)}>
              {t('projects:wizard.next', {
                step: t(`projects:wizard.steps.${nextStep}`),
              })}
            </Button>
          ) : (
            <Button
              onClick={() => void finish()}
              disabled={blockers.length > 0 || publishing}
            >
              <Check className="size-4" />
              {project.status === 'draft'
                ? t('projects:detail.publish')
                : t('projects:wizard.finish')}
            </Button>
          )}
        </div>
      </div>
    </main>
  )
}

/** Done or still blocking, for the steps publishing depends on; null for the
 *  ones whose every field is optional. */
function stepStatus(
  step: WizardStep,
  blockers: Array<PublishBlocker>,
): 'done' | 'todo' | null {
  if (step !== 'questions' && step !== 'criteria') return null
  return blockers.some((blocker) => stepOfBlocker(blocker) === step)
    ? 'todo'
    : 'done'
}
