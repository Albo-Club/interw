/**
 * What stops a role from going live (M10). One rule, read by the wizard's
 * review step and enforced by `projects.publish`, so the button and the
 * server cannot disagree about what "ready" means.
 *
 * The wizard seeds a new question and a new criterion with the example its
 * field shows, so that "Add" opens an editable card rather than an error. The
 * example is then indistinguishable from a real entry unless we compare it to
 * the copy itself — hence the locale files, read here rather than duplicated:
 * a role published with the example question sends a candidate a question the
 * recruiter never asked, and scores them against a criterion nobody defined.
 */

import enProjects from '../../src/locales/en/projects.json'
import frProjects from '../../src/locales/fr/projects.json'

const EXAMPLE_QUESTIONS = new Set(
  [enProjects, frProjects].map((l) => l.questions.fields.contentPlaceholder),
)
const EXAMPLE_CRITERIA = new Set(
  [enProjects, frProjects].map((l) => l.criteria.fields.labelPlaceholder),
)

export type PublishBlocker =
  | { code: 'no_questions' | 'no_criteria' }
  | { code: 'question_not_written' | 'criterion_not_named'; position: number }

function unwritten(text: string, examples: Set<string>): boolean {
  const trimmed = text.trim()
  return trimmed === '' || examples.has(trimmed)
}

/** Every reason the role cannot be published yet, in the order to fix them.
 *  `position` is 1-based, as the recruiter numbers them. */
export function publishBlockers(
  questions: ReadonlyArray<{ content: string }>,
  criteria: ReadonlyArray<{ label: string }>,
): Array<PublishBlocker> {
  const blockers: Array<PublishBlocker> = []
  if (questions.length === 0) blockers.push({ code: 'no_questions' })
  questions.forEach((q, i) => {
    if (unwritten(q.content, EXAMPLE_QUESTIONS)) {
      blockers.push({ code: 'question_not_written', position: i + 1 })
    }
  })
  if (criteria.length === 0) blockers.push({ code: 'no_criteria' })
  criteria.forEach((c, i) => {
    if (unwritten(c.label, EXAMPLE_CRITERIA)) {
      blockers.push({ code: 'criterion_not_named', position: i + 1 })
    }
  })
  return blockers
}
