import { useState } from 'react'
import { useConvexAction, useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { Sparkles } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import type { Id } from '../../../../convex/_generated/dataModel'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Alert, AlertDescription } from '~/components/ui/alert'
import { Field, FieldDescription, FieldLabel } from '~/components/ui/field'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog'

type Draft = {
  title: string
  jobTitle: string
  questions: Array<{ title: string; content: string }>
  criteria: Array<{ label: string; description: string; weight: number }>
}

/**
 * Draft an interview from a published job ad.
 *
 * The draft is shown before anything is written, and the disclaimer stays on
 * screen while it is reviewed. What a candidate is asked, and what they are
 * scored against, is the recruiter's call — not a model's.
 */
export function ImportFromUrlDialog({
  projectId,
  open,
  onOpenChange,
}: {
  projectId: Id<'projects'>
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation(['projects', 'common'])
  const importFromUrl = useConvexAction(api.jobImport.importFromUrl)
  const createQuestion = useConvexMutation(api.questions.create)
  const createCriterion = useConvexMutation(api.criteria.create)

  const [url, setUrl] = useState('')
  const [working, setWorking] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)

  const notify = (error: unknown) => {
    const { key, fallbackKey } = errorMessageKey(error, 'projects')
    toast.error(t(key, { defaultValue: t(fallbackKey) }))
  }

  const run = async () => {
    setWorking(true)
    try {
      setDraft(await importFromUrl({ projectId, url }))
    } catch (error) {
      notify(error)
    } finally {
      setWorking(false)
    }
  }

  const apply = async () => {
    if (!draft) return
    setWorking(true)
    try {
      for (const question of draft.questions) {
        await createQuestion({
          projectId,
          title: question.title,
          content: question.content,
        })
      }
      for (const criterion of draft.criteria) {
        await createCriterion({
          projectId,
          label: criterion.label,
          description: criterion.description,
          weight: criterion.weight,
        })
      }
      setDraft(null)
      setUrl('')
      onOpenChange(false)
    } catch (error) {
      notify(error)
    } finally {
      setWorking(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('projects:import.title')}</DialogTitle>
          <DialogDescription>{t('projects:import.subtitle')}</DialogDescription>
        </DialogHeader>

        {draft === null ? (
          <Field>
            <FieldLabel htmlFor="import-url">
              {t('projects:import.url')}
            </FieldLabel>
            <Input
              id="import-url"
              type="url"
              inputMode="url"
              value={url}
              placeholder={t('projects:import.urlPlaceholder')}
              onChange={(event) => setUrl(event.target.value)}
            />
            <FieldDescription>
              {t('projects:import.disclaimer')}
            </FieldDescription>
          </Field>
        ) : (
          <div className="space-y-4">
            <Alert>
              <Sparkles className="size-4" />
              <AlertDescription>
                {t('projects:import.resultBody')}
              </AlertDescription>
            </Alert>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                {t('projects:detail.questions')}
              </h3>
              <ol className="space-y-2">
                {draft.questions.map((question, index) => (
                  <li key={index} className="text-sm">
                    <span className="text-muted-foreground mr-2 tabular-nums">
                      {index + 1}.
                    </span>
                    {question.content}
                  </li>
                ))}
              </ol>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold">
                {t('projects:detail.criteria')}
              </h3>
              <ul className="space-y-1">
                {draft.criteria.map((criterion, index) => (
                  <li key={index} className="flex justify-between gap-4 text-sm">
                    <span>{criterion.label}</span>
                    <span className="text-muted-foreground tabular-nums">
                      {criterion.weight}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <p className="text-muted-foreground text-xs">
              {t('projects:import.disclaimer')}
            </p>
          </div>
        )}

        <DialogFooter>
          {draft === null ? (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t('common:actions.cancel')}
              </Button>
              <Button onClick={() => void run()} disabled={working || !url}>
                {working
                  ? t('projects:import.working')
                  : t('projects:import.submit')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => setDraft(null)}>
                {t('projects:import.discard')}
              </Button>
              <Button onClick={() => void apply()} disabled={working}>
                {t('projects:import.apply')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
