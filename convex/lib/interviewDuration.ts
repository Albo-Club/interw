/**
 * How long a candidate should set aside for a role, derived from its
 * questions and never typed by hand.
 *
 * A role used to carry its own `maxDurationMinutes`. Nothing enforced it, but
 * the candidate was told it — and a role set to 30 minutes whose questions
 * took longer sent candidates in with too little time. The per-question
 * answer time is the only limit the recorder applies, so it is the only
 * input here.
 */

/** Reading or watching a question, and the beat before recording starts. */
const SECONDS_TO_READ_A_QUESTION = 30

export function maxInterviewMinutes(
  questions: ReadonlyArray<{ maxResponseSeconds: number }>,
): number {
  const seconds = questions.reduce(
    (total, question) =>
      total + question.maxResponseSeconds + SECONDS_TO_READ_A_QUESTION,
    0,
  )
  return Math.ceil(seconds / 60)
}
