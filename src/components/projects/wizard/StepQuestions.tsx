import { useState } from 'react'
import { useConvexMutation } from '@convex-dev/react-query'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Clock, Plus, Sparkles, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { api } from '../../../../convex/_generated/api'
import { maxInterviewMinutes } from '../../../../convex/lib/interviewDuration'
import { ImportFromUrlDialog } from './ImportFromUrlDialog'
import type { TFunction } from 'i18next'
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select'
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
import { useProjectPlayback } from '~/components/projects/useProjectPlayback'

/** The answer times a recruiter picks from, inside the server's 15–600 s. A
 *  list rather than a free number: nobody thinks of an answer in seconds. */
const RESPONSE_PRESETS = [30, 60, 90, 120, 180, 300, 600]

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
  const { playback, refresh: refreshPlayback } = useProjectPlayback(
    project._id,
    questions.flatMap((q) => (q.hasMedia ? [q._id] : [])).join(','),
  )

  const notify = (error: unknown) => {
    const { key, fallbackKey } = errorMessageKey(error, 'projects')
    toast.error(t(key, { defaultValue: t(fallbackKey) }))
  }

  // `questions.create` refuses empty content — a question with no text is not
  // a question. Seed the example the field shows as its placeholder, the way
  // StepCriteria seeds a new criterion, so the button opens an editable card
  // instead of firing `invalid_content` at a recruiter who has typed nothing
  // yet.
  const add = () =>
    void create({
      projectId: project._id,
      content: t('projects:questions.fields.contentPlaceholder'),
    }).catch(notify)

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

      {/* The one figure the candidate is told, computed live from the answer
          times below — so it can never disagree with them. */}
      {questions.length > 0 && (
        <div className="bg-muted/50 flex items-start gap-3 rounded-lg border p-4">
          <Clock
            aria-hidden
            className="text-muted-foreground mt-0.5 size-5 shrink-0"
          />
          <div className="space-y-0.5" aria-live="polite">
            <p className="text-sm">
              {t('projects:questions.duration.label')}{' '}
              <strong className="text-base font-semibold tabular-nums">
                {t('projects:questions.duration.value', {
                  count: maxInterviewMinutes(questions),
                })}
              </strong>
            </p>
            <p className="text-muted-foreground text-sm">
              {t('projects:questions.duration.hint')}
            </p>
          </div>
        </div>
      )}

      {questions.length === 0 ? (
        <EmptyState
          title={t('projects:questions.empty.title')}
          body={t('projects:questions.empty.body')}
          action={
            <Button onClick={add}>
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
                playback={
                  playback?.questions.find((q) => q.questionId === question._id) ??
                  null
                }
                onMediaChanged={refreshPlayback}
                onMove={(direction) => void move(index, direction)}
                onDelete={() => setPendingDelete(question)}
              />
            </li>
          ))}
        </ol>
      )}

      {questions.length > 0 && (
        <Button variant="outline" onClick={add}>
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
  playback,
  onMediaChanged,
  onMove,
  onDelete,
}: {
  question: WizardQuestion
  playback: { url: string; kind: 'audio' | 'video' } | null
  onMediaChanged: () => void
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
  // A legacy value outside the presets stays selectable rather than being
  // silently rounded on the next save.
  const responseOptions = RESPONSE_PRESETS.includes(question.maxResponseSeconds)
    ? RESPONSE_PRESETS
    : [...RESPONSE_PRESETS, question.maxResponseSeconds].sort((a, b) => a - b)

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
              <Select
                value={String(question.maxResponseSeconds)}
                onValueChange={(value) =>
                  void save({
                    questionId: question._id,
                    maxResponseSeconds: Number(value),
                  })
                }
              >
                <SelectTrigger
                  id={`q-seconds-${question._id}`}
                  className="max-w-40 tabular-nums"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {responseOptions.map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {formatAnswerTime(t, option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <FieldDescription>
                {t('projects:questions.fields.maxResponseHint')}
              </FieldDescription>
            </Field>
          </FieldGroup>
        </div>

        <MediaRecorderField
          target={{ kind: 'question', questionId: question._id }}
          hasMedia={question.hasMedia}
          playback={playback}
          onChanged={onMediaChanged}
        />
      </CardContent>
    </Card>
  )
}

/** 90 → "1 min 30 s", 120 → "2 min", 30 → "30 s". */
function formatAnswerTime(t: TFunction, seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes === 0) return t('projects:questions.time.seconds', { count: rest })
  if (rest === 0) return t('projects:questions.time.minutes', { count: minutes })
  return t('projects:questions.time.minutesSeconds', { minutes, seconds: rest })
}
