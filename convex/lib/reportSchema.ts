/**
 * The shape a model must produce for an interview report, and nothing else.
 *
 * References are INDICES, not ids. A model handed "criterion 0, criterion 1"
 * cannot invent a criterion the way it can invent a `k57d8...` — and an index
 * outside the range fails validation instead of being written. The previous
 * build asked for uuids and then had to defend against fabricated ones.
 */

import { z } from 'zod'

const evidenceSchema = z.object({
  /** Which answer this quote came from, 0-based, in the order asked. */
  answerIndex: z.number().int().min(0),
  /** The candidate's words, as closely as possible — used to find the moment. */
  quote: z.string().min(3).max(400),
  /** Approximate seconds into that answer. Only a fallback; the transcript wins. */
  startSeconds: z.number().min(0).max(36_000),
})

export const reportOutputSchema = z.object({
  /** One sentence a recruiter would say to their manager. */
  verdictHeadline: z.string().min(10).max(160),
  executiveSummary: z.string().min(40).max(2_000),
  overallScore: z.number().int().min(0).max(100),
  recommendation: z.enum(['strong_no', 'no', 'maybe', 'yes', 'strong_yes']),
  // No minimum: an inaudible or off-topic interview has none, and the prompt
  // asks the model to say so rather than invent one.
  strengths: z.array(z.string().min(3).max(240)).max(5),
  concerns: z.array(z.string().min(3).max(240)).max(5),
  /** One entry per criterion, every criterion, in index order. */
  criteria: z
    .array(
      z.object({
        criterionIndex: z.number().int().min(0),
        score: z.number().int().min(0).max(100),
        level: z.enum(['excellent', 'solid', 'partial', 'gap']),
        rationale: z.string().min(10).max(600),
        evidence: z.array(evidenceSchema).max(3),
      }),
    )
    .min(1),
  /** One entry per answered question. */
  answers: z
    .array(
      z.object({
        answerIndex: z.number().int().min(0),
        score: z.number().int().min(0).max(10),
        summary: z.string().min(5).max(400),
        depth: z.enum(['surface', 'concrete', 'expert']),
        evidence: evidenceSchema.nullable(),
      }),
    )
    .min(1),
  /** Up to three moments worth watching. */
  highlights: z
    .array(
      z.object({
        answerIndex: z.number().int().min(0),
        startSeconds: z.number().min(0).max(36_000),
        endSeconds: z.number().min(0).max(36_000),
        kind: z.enum(['strength', 'personality', 'watchpoint']),
        label: z.string().min(3).max(80),
      }),
    )
    .max(3),
})

export type ReportOutput = z.infer<typeof reportOutputSchema>
