import type { PublishBlocker } from '../../../../convex/lib/publishReadiness'

export const WIZARD_STEPS = [
  'questions',
  'criteria',
  'candidate',
  'publish',
] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** The step where a publish blocker gets fixed. */
export function stepOfBlocker(blocker: PublishBlocker): WizardStep {
  return blocker.code === 'no_questions' ||
    blocker.code === 'question_not_written'
    ? 'questions'
    : 'criteria'
}
