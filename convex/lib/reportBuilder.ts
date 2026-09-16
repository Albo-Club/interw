/**
 * Turning a validated model answer into the row that gets written.
 *
 * Pure, so the rules that decide what a recruiter sees are testable without a
 * model, a deployment or a bucket. Three of them matter:
 *
 *  1. An index that does not resolve is a hard failure, not a dropped entry.
 *     Silently skipping a criterion would shift the weighted average without
 *     anyone noticing, and a report that is quietly wrong is worse than one
 *     that failed and retried.
 *  2. Every criterion must be scored. Partial coverage means the weighting the
 *     recruiter configured did not happen.
 *  3. Every quote is re-anchored against the transcript. The model's own
 *     offset is only ever a fallback.
 */

import { ConvexError } from 'convex/values'

import { chooseStartSeconds } from './evidence'
import { weightedScore } from './weights'
import type { TimedChunk } from './evidence'
import type { ReportOutput } from './reportSchema'
import type { Doc, Id } from '../_generated/dataModel'

export type CriterionInput = {
  _id: Id<'criteria'>
  label: string
  normalizedWeight: number
}

export type AnswerInput = {
  segmentId: Id<'segments'>
  questionId: Id<'questions'>
  questionIndex: number
  durationSeconds: number | null
  chunks: ReadonlyArray<TimedChunk>
}

export type BuiltReport = {
  overallScore: number
  recommendation: Doc<'reports'>['recommendation']
  executiveSummary: string
  criteriaScores: Doc<'reports'>['criteriaScores']
  strengths: Array<string>
  concerns: Array<string>
  fitMatrix: NonNullable<Doc<'reports'>['fitMatrix']>
  highlights: NonNullable<Doc<'reports'>['highlights']>
}

function requireIndex<T>(
  list: ReadonlyArray<T>,
  index: number,
  what: string,
): T {
  const value = list[index]
  if (value === undefined) {
    throw new ConvexError(`report_references_unknown_${what}`)
  }
  return value
}

export function buildReport({
  output,
  criteria,
  answers,
  headlineIntoSummary = true,
}: {
  output: ReportOutput
  criteria: ReadonlyArray<CriterionInput>
  answers: ReadonlyArray<AnswerInput>
  headlineIntoSummary?: boolean
}): BuiltReport {
  if (criteria.length === 0) throw new ConvexError('report_without_criteria')

  const anchor = (evidence: {
    answerIndex: number
    quote: string
    startSeconds: number
  }) => {
    const answer = requireIndex(answers, evidence.answerIndex, 'answer')
    // `evidence.startSeconds` — the model's own guess — is read off the
    // output and deliberately not used. The transcript anchors the quote or
    // nothing does.
    const startSeconds = chooseStartSeconds({
      chunks: answer.chunks,
      quote: evidence.quote,
      durationSeconds: answer.durationSeconds,
    })
    return {
      segmentId: answer.segmentId,
      quote: evidence.quote,
      startSeconds: startSeconds ?? undefined,
      anchored: startSeconds !== null,
    }
  }

  // Every criterion, exactly once. A duplicate would double-count its weight.
  const byCriterion = new Map<number, ReportOutput['criteria'][number]>()
  for (const entry of output.criteria) {
    requireIndex(criteria, entry.criterionIndex, 'criterion')
    if (byCriterion.has(entry.criterionIndex)) {
      throw new ConvexError('report_scores_a_criterion_twice')
    }
    byCriterion.set(entry.criterionIndex, entry)
  }
  if (byCriterion.size !== criteria.length) {
    throw new ConvexError('report_missing_criteria')
  }

  const criteriaScores: BuiltReport['criteriaScores'] = []
  const fitCriteria: BuiltReport['fitMatrix']['criteria'] = []
  for (const [index, criterion] of criteria.entries()) {
    const entry = byCriterion.get(index)
    if (!entry) throw new ConvexError('report_missing_criteria')
    criteriaScores.push({
      criterionId: criterion._id,
      score: entry.score,
      rationale: entry.rationale,
      evidence: entry.evidence.map(anchor),
    })
    fitCriteria.push({
      criterionId: criterion._id,
      score: entry.score,
      level: entry.level,
      statement: entry.rationale,
    })
  }

  const fitQuestions: BuiltReport['fitMatrix']['questions'] = []
  const seenAnswers = new Set<number>()
  for (const entry of output.answers) {
    const answer = requireIndex(answers, entry.answerIndex, 'answer')
    if (seenAnswers.has(entry.answerIndex)) continue
    seenAnswers.add(entry.answerIndex)
    fitQuestions.push({
      questionId: answer.questionId,
      questionIndex: answer.questionIndex,
      score: entry.score,
      summary: entry.summary,
      depth: entry.depth,
      evidence: entry.evidence ? anchor(entry.evidence) : undefined,
    })
  }

  // Hybrid score: half the model's holistic read, half the weighting the
  // recruiter actually configured. Either alone is worse — the model ignores
  // the weights it was given, and the weighted mean ignores everything the
  // criteria did not cover.
  const weighted = weightedScore(
    criteria.map((criterion, index) => ({
      normalizedWeight: criterion.normalizedWeight,
      score: byCriterion.get(index)?.score ?? null,
    })),
  )
  const overallScore = Math.round(
    weighted === null ? output.overallScore : (output.overallScore + weighted) / 2,
  )

  const highlights: BuiltReport['highlights'] = output.highlights.map(
    (highlight) => {
      const answer = requireIndex(answers, highlight.answerIndex, 'answer')
      const duration = answer.durationSeconds ?? 0
      const start = duration > 0 ? Math.min(highlight.startSeconds, duration) : highlight.startSeconds
      // A clip that ends before it starts, or runs past the recording, plays
      // as a black frame — which reads as a broken product.
      const end = Math.max(
        start + 5,
        duration > 0 ? Math.min(highlight.endSeconds, duration) : highlight.endSeconds,
      )
      return {
        segmentId: answer.segmentId,
        startSeconds: start,
        endSeconds: end,
        kind: highlight.kind,
        label: highlight.label,
      }
    },
  )

  return {
    overallScore,
    recommendation: output.recommendation,
    executiveSummary: headlineIntoSummary
      ? `${output.verdictHeadline}\n\n${output.executiveSummary}`
      : output.executiveSummary,
    criteriaScores,
    strengths: output.strengths,
    concerns: output.concerns,
    fitMatrix: { criteria: fitCriteria, questions: fitQuestions },
    highlights,
  }
}
