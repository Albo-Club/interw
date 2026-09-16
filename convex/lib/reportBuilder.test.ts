import { ConvexError } from 'convex/values'
import { describe, expect, it } from 'vitest'

import { buildReport } from './reportBuilder'
import type { AnswerInput, CriterionInput } from './reportBuilder'
import type { ReportOutput } from './reportSchema'
import type { DataModel, Id } from '../_generated/dataModel'

const id = <T extends keyof DataModel>(table: T, suffix: string) =>
  `${table}_${suffix}` as Id<T>

const criteria: Array<CriterionInput> = [
  { _id: id('criteria', 'a'), label: 'Technical depth', normalizedWeight: 60 },
  { _id: id('criteria', 'b'), label: 'Ownership', normalizedWeight: 40 },
]

const answers: Array<AnswerInput> = [
  {
    segmentId: id('segments', '0'),
    questionId: id('questions', '0'),
    questionIndex: 0,
    durationSeconds: 90,
    chunks: [
      { start: 0, end: 10, text: "J'ai dirigé la migration vers Postgres." },
      { start: 10, end: 30, text: 'On a coupé la latence de moitié.' },
    ],
  },
  {
    segmentId: id('segments', '1'),
    questionId: id('questions', '1'),
    questionIndex: 1,
    durationSeconds: 60,
    chunks: [{ start: 0, end: 20, text: "J'ai porté le sujet seul pendant six mois." }],
  },
]

function output(overrides: Partial<ReportOutput> = {}): ReportOutput {
  return {
    verdictHeadline: 'Solid senior profile, to confirm on management.',
    executiveSummary:
      'Clear on the technical side with concrete examples, thinner on how they carried the team through it.',
    overallScore: 70,
    recommendation: 'yes',
    strengths: ['Led a real migration end to end'],
    concerns: ['Little evidence of managing others'],
    criteria: [
      {
        criterionIndex: 0,
        score: 80,
        level: 'solid',
        rationale: 'Names the decisions and the trade-offs behind them.',
        evidence: [
          {
            answerIndex: 0,
            quote: 'la migration vers Postgres',
            startSeconds: 42,
          },
        ],
      },
      {
        criterionIndex: 1,
        score: 50,
        level: 'partial',
        rationale: 'Claims ownership but gives no example of a hard call.',
        evidence: [],
      },
    ],
    answers: [
      {
        answerIndex: 0,
        score: 8,
        summary: 'Describes the migration and its measured effect.',
        depth: 'concrete',
        evidence: {
          answerIndex: 0,
          quote: 'On a coupé la latence de moitié',
          startSeconds: 0,
        },
      },
      {
        answerIndex: 1,
        score: 5,
        summary: 'Asserts ownership without an example.',
        depth: 'surface',
        evidence: null,
      },
    ],
    highlights: [
      {
        answerIndex: 0,
        startSeconds: 4,
        endSeconds: 20,
        kind: 'strength',
        label: 'The migration in their own words',
      },
    ],
    ...overrides,
  }
}

const build = (o: ReportOutput = output()) =>
  buildReport({ output: o, criteria, answers })

describe('buildReport', () => {
  it('maps criterion indices onto real criterion ids', () => {
    const report = build()
    expect(report.criteriaScores.map((c) => c.criterionId)).toEqual([
      criteria[0]._id,
      criteria[1]._id,
    ])
  })

  // Half the model's holistic read, half the weighting the recruiter set.
  // 80×0.6 + 50×0.4 = 68; (70 + 68) / 2 = 69.
  it('blends the model score with the recruiter weighting', () => {
    expect(build().overallScore).toBe(69)
  })

  it('respects the weights, not just the arithmetic mean', () => {
    const flipped = buildReport({
      output: output(),
      criteria: [
        { ...criteria[0], normalizedWeight: 10 },
        { ...criteria[1], normalizedWeight: 90 },
      ],
      answers,
    })
    // 80×0.1 + 50×0.9 = 53; (70 + 53) / 2 = 61.5 → 62.
    expect(flipped.overallScore).toBe(62)
  })

  it('re-anchors a quote against the transcript, ignoring the model estimate', () => {
    const report = build()
    expect(report.criteriaScores[0].evidence[0]).toMatchObject({
      segmentId: answers[0].segmentId,
      startSeconds: 0,
      anchored: true,
    })
  })

  /**
   * A model paraphrases a hesitant answer — routinely — and produces a quote
   * the transcript cannot match. The offset it supplied alongside used to be
   * written as if it were an anchor, so the recruiter clicked and landed on
   * the candidate saying something else.
   */
  it('marks a quote it cannot find as unanchored, with no offset at all', () => {
    const report = build(
      output({
        criteria: [
          {
            ...output().criteria[0],
            evidence: [
              {
                answerIndex: 0,
                quote: 'a sentence the candidate never said',
                startSeconds: 42,
              },
            ],
          },
          output().criteria[1],
        ],
      }),
    )
    expect(report.criteriaScores[0].evidence[0]).toMatchObject({
      segmentId: answers[0].segmentId,
      quote: 'a sentence the candidate never said',
      anchored: false,
    })
    expect(report.criteriaScores[0].evidence[0].startSeconds).toBeUndefined()
  })

  it('anchors nothing when the transcript came back without timings', () => {
    const untimed: Array<AnswerInput> = answers.map((answer) => ({
      ...answer,
      chunks: [],
    }))
    const report = buildReport({ output: output(), criteria, answers: untimed })
    expect(report.criteriaScores[0].evidence[0].anchored).toBe(false)
    expect(report.criteriaScores[0].evidence[0].startSeconds).toBeUndefined()
  })

  it('anchors a quote from a later chunk to that chunk, not the answer start', () => {
    const report = build()
    expect(report.fitMatrix.questions[0].evidence?.startSeconds).toBe(10)
  })

  // Dropping a criterion would shift the weighted average with nobody the
  // wiser. A report that is quietly wrong is worse than one that retried.
  it('refuses a report that skipped a criterion', () => {
    expect(() =>
      build(output({ criteria: [output().criteria[0]] })),
    ).toThrow(ConvexError)
  })

  it('refuses a criterion scored twice', () => {
    const twice = output()
    expect(() =>
      build(
        output({
          criteria: [twice.criteria[0], { ...twice.criteria[0] }],
        }),
      ),
    ).toThrow(/twice/)
  })

  it('refuses an invented criterion index', () => {
    const bad = output()
    bad.criteria[1] = { ...bad.criteria[1], criterionIndex: 7 }
    expect(() => build(bad)).toThrow(/unknown_criterion/)
  })

  it('refuses an invented answer index in evidence', () => {
    const bad = output()
    bad.criteria[0].evidence[0].answerIndex = 9
    expect(() => build(bad)).toThrow(/unknown_answer/)
  })

  it('refuses when there are no criteria to score against', () => {
    expect(() =>
      buildReport({ output: output(), criteria: [], answers }),
    ).toThrow(/without_criteria/)
  })

  // A clip that ends before it starts, or runs past the recording, plays as a
  // black frame and reads as a broken product.
  it('clamps a highlight to the recording and keeps it at least five seconds', () => {
    const report = build(
      output({
        highlights: [
          {
            answerIndex: 0,
            startSeconds: 200,
            endSeconds: 1,
            kind: 'watchpoint',
            label: 'Hesitation',
          },
        ],
      }),
    )
    expect(report.highlights[0].startSeconds).toBe(90)
    expect(report.highlights[0].endSeconds).toBeGreaterThanOrEqual(95)
  })

  it('puts the verdict at the top of the summary a recruiter reads first', () => {
    expect(build().executiveSummary.startsWith('Solid senior profile')).toBe(
      true,
    )
  })

  it('carries strengths, concerns and the recommendation through unchanged', () => {
    const report = build()
    expect(report.recommendation).toBe('yes')
    expect(report.strengths).toEqual(['Led a real migration end to end'])
    expect(report.concerns).toEqual(['Little evidence of managing others'])
  })
})
