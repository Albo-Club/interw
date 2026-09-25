import type { PublishBlocker } from '../../../../convex/lib/publishReadiness'

export const WIZARD_STEPS = [
  'questions',
  'criteria',
  'candidate',
  'publish',
] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/** The step where each publish blocker gets fixed. Exhaustive, so a new
 *  blocker code does not compile until it is given a step. */
const STEP_OF_BLOCKER: Record<PublishBlocker['code'], WizardStep> = {
  no_questions: 'questions',
  question_not_written: 'questions',
  no_criteria: 'criteria',
  criterion_not_named: 'criteria',
}

export function stepOfBlocker(blocker: PublishBlocker): WizardStep {
  return STEP_OF_BLOCKER[blocker.code]
}

const GATED_STEPS = new Set(Object.values(STEP_OF_BLOCKER))

/** Done or still blocking, for the steps publishing depends on; null for the
 *  ones whose every field is optional. */
export function stepStatus(
  step: WizardStep,
  blockers: ReadonlyArray<PublishBlocker>,
): 'done' | 'todo' | null {
  if (!GATED_STEPS.has(step)) return null
  return blockers.some((blocker) => stepOfBlocker(blocker) === step)
    ? 'todo'
    : 'done'
}
