import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { ImportFromUrlDialog } from './ImportFromUrlDialog'
import type { WizardProject, WizardQuestion } from './types'
import { errorMessageKey } from '~/lib/convex-errors'
import { Button } from '~/components/ui/button'
import { Input } from '~/components/ui/input'
import { Textarea } from '~/components/ui/textarea'
import { Card, CardContent } from '~/components/ui/card'
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '~/components/ui/field'
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
import { EmptyState } from '~/components/projects/EmptyState'
import { MediaRecorderField } from '~/components/projects/MediaRecorderField'

export function StepQuestions({
  project,
  questions,
}: {
  project: WizardProject
  questions: Array<WizardQuestion>
}) {
  const { t } = useTranslation(['projects', 'common'])
  const create = useConvexMutation(api.questions.create)
  const reorder = useConvexMutation(api.questions.reorder)
  const remove = useConvexMutation(api.questions.remove)
  const [pendingDelete, setPendingDelete] = useState<WizardQuestion | null>(null)
  const [importOpen, setImportOpen] = useState(false)

  const notify = (error: unknown) => {
    const { key, fallbackKey } = errorMessageKey(error, 'projects')
    toast.error(t(key, { defaultValue: t(fallbackKey) }))
  }

  const move = async (index: number, direction: -1 | 1) => {
    const next = [...questions]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    try {
      await reorder({
        projectId: project._id,
        orderedIds: next.map((question) => question._id),
      })
    } catch (error) {
      notify(error)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-lg font-semibold">
            {t('projects:questions.title')}
          </h2>
          <p className="text-muted-foreground max-w-prose text-sm">
            {t('projects:questions.subtitle')}
          </p>
        </div>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Sparkles className="size-4" />
          {t('projects:questions.import')}
        </Button>
      </div>

      {questions.length === 0 ? (
        <EmptyState
          title={t('projects:questions.empty.title')}
          body={t('projects:questions.empty.body')}
          action={
            <Button
              onClick={() =>
                void create({ projectId: project._id, content: '' }).catch(
                  notify,
                )
              }
            >
              <Plus className="size-4" />
              {t('projects:questions.add')}
            </Button>
          }
        />
      ) : (
        <ol className="space-y-4">
          {questions.map((question, index) => (
            <li key={question._id}>
              <QuestionCard
                question={question}
                index={index}
                total={questions.length}
                onMove={(direction) => void move(index, direction)}
                onDelete={() => setPendingDelete(question)}
              />
            </li>
          ))}
        </ol>
      )}

      {questions.length > 0 && (
        <Button
          variant="outline"
          onClick={() =>
            void create({ projectId: project._id, content: '' }).catch(notify)
          }
        >
          <Plus className="size-4" />
          {t('projects:questions.add')}
        </Button>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('projects:questions.removeConfirm.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('projects:questions.removeConfirm.body', {
                question:
                  pendingDelete?.title ??
                  pendingDelete?.content.slice(0, 60) ??
                  '',
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) {
                  void remove({ questionId: pendingDelete._id }).catch(notify)
                }
                setPendingDelete(null)
              }}
            >
              {t('projects:questions.removeConfirm.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <ImportFromUrlDialog
        projectId={project._id}
        open={importOpen}
        onOpenChange={setImportOpen}
      />
    </div>
  )
}

function QuestionCard({
  question,
  index,
  total,
  onMove,
  onDelete,
}: {
  question: WizardQuestion
  index: number
  total: number
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
}) {
  const { t } = useTranslation(['projects', 'common'])
  const update = useConvexMutation(api.questions.update)
  const [title, setTitle] = useState(question.title ?? '')
  const [content, setContent] = useState(question.content)
  const [hint, setHint] = useState(question.hintText ?? '')
  const [seconds, setSeconds] = useState(String(question.maxResponseSeconds))

  const save = async (patch: Parameters<typeof update>[0]) => {
    try {
      await update(patch)
    } catch (error) {
      const { key, fallbackKey } = errorMessageKey(error, 'projects')
      toast.error(t(key, { defaultValue: t(fallbackKey) }))
    }
  }

  return (
    <Card>
      <CardContent className="grid gap-6 pt-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase tabular-nums">
              {t('projects:questions.position', {
                index: index + 1,
                total,
              })}
            </span>
            <div className="flex gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={index === 0}
                onClick={() => onMove(-1)}
                aria-label={t('projects:questions.moveUp')}
              >
                <ArrowUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8"
                disabled={index === total - 1}
                onClick={() => onMove(1)}
                aria-label={t('projects:questions.moveDown')}
              >
                <ArrowDown className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="text-destructive size-8"
                onClick={onDelete}
                aria-label={t('projects:questions.remove')}
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={`q-title-${question._id}`}>
                {t('projects:questions.fields.title')}
              </FieldLabel>
              <Input
                id={`q-title-${question._id}`}
                value={title}
                placeholder={t('projects:questions.fields.titlePlaceholder')}
                onChange={(event) => setTitle(event.target.value)}
                onBlur={() => void save({ questionId: question._id, title })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`q-content-${question._id}`}>
                {t('projects:questions.fields.content')}
              </FieldLabel>
              <Textarea
                id={`q-content-${question._id}`}
                rows={3}
                value={content}
                placeholder={t('projects:questions.fields.contentPlaceholder')}
                onChange={(event) => setContent(event.target.value)}
                onBlur={() => void save({ questionId: question._id, content })}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`q-hint-${question._id}`}>
                {t('projects:questions.fields.hint')}
              </FieldLabel>
              <Input
                id={`q-hint-${question._id}`}
                value={hint}
                placeholder={t('projects:questions.fields.hintPlaceholder')}
                onChange={(event) => setHint(event.target.value)}
                onBlur={() =>
                  void save({ questionId: question._id, hintText: hint })
                }
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={`q-seconds-${question._id}`}>
                {t('projects:questions.fields.maxResponse')}
              </FieldLabel>
              <Input
                id={`q-seconds-${question._id}`}
                type="number"
                min={15}
                max={600}
                step={15}
                inputMode="numeric"
                className="max-w-32 tabular-nums"
                value={seconds}
                onChange={(event) => setSeconds(event.target.value)}
                onBlur={() => {
                  const parsed = Number.parseInt(seconds, 10)
                  if (Number.isNaN(parsed)) {
                    setSeconds(String(question.maxResponseSeconds))
                    return
                  }
                  void save({
                    questionId: question._id,
                    maxResponseSeconds: parsed,
                  })
                }}
              />
              <FieldDescription>
                {t('projects:questions.fields.maxResponseHint')}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </div>

        <MediaRecorderField
          questionId={question._id}
          hasMedia={question.hasMedia}
          onChanged={() => undefined}
        />
      </CardContent>
    </Card>
  )
}
