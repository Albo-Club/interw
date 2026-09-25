/**
 * "Import a job ad" — paste a URL, get a draft interview to edit.
 *
 * The draft is returned, never written. A recruiter reviews and accepts it in
 * the wizard, which matters beyond UX: the questions a candidate is judged on
 * are the recruiter's responsibility, and a model must not be able to put
 * words into a live interview on its own.
 */

import { ConvexError, v } from 'convex/values'
import { z } from 'zod'

import { action, internalQuery, mutation } from './_generated/server'
import { internal } from './_generated/api'
import { complete } from './lib/ai'
import { htmlToText, jobPostingText } from './lib/htmlText'
import { jobImportPrompt } from './lib/prompts'
import { requireProjectEditable } from './lib/projectAccess'
import { consumeLimit } from './rateLimiters'
import { appendQuestions } from './questions'
import { appendCriteria } from './criteria'

const DEFAULT_QUESTION_COUNT = 6
const DEFAULT_CRITERIA_COUNT = 4
const MIN_USABLE_TEXT = 400

/** Bounds `draftSchema` enforces, shared with the prompt so it never asks for
 *  a draft that is bound to fail validation. */
const QUESTION_RANGE = { min: 3, max: 15 } as const
const CRITERIA_RANGE = { min: 2, max: 8 } as const

/**
 * The count the prompt asks for. Clamped rather than refused: the UI sends
 * none, and an out-of-range number used to reach the prompt as is, which
 * guaranteed a billed completion that then failed `draftSchema`.
 */
export function draftCount(
  requested: number | undefined,
  fallback: number,
  range: { min: number; max: number },
): number {
  if (requested === undefined || !Number.isFinite(requested)) return fallback
  return Math.min(range.max, Math.max(range.min, Math.round(requested)))
}

const draftSchema = z.object({
  title: z.string().min(1).max(120),
  jobTitle: z.string().min(1).max(120),
  questions: z
    .array(
      z.object({
        title: z.string().min(1).max(120),
        content: z.string().min(10).max(1000),
      }),
    )
    .min(QUESTION_RANGE.min)
    .max(QUESTION_RANGE.max),
  criteria: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string().max(500),
        weight: z.number().int().min(1).max(100),
      }),
    )
    .min(CRITERIA_RANGE.min)
    .max(CRITERIA_RANGE.max),
})

export type InterviewDraft = z.infer<typeof draftSchema>

/** Auth + the project's language, which decides the language of the draft. */
export const resolveImportContext = internalQuery({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project, user } = await requireProjectEditable(ctx, projectId)
    return { language: project.language, actorId: user._id }
  },
})

export const importFromUrl = action({
  args: {
    projectId: v.id('projects'),
    url: v.string(),
    questionCount: v.optional(v.number()),
    criteriaCount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<InterviewDraft> => {
    const context = await ctx.runQuery(
      internal.jobImport.resolveImportContext,
      { projectId: args.projectId },
    )
    await consumeLimit(ctx, 'jobImport', context.actorId)

    // Fetching happens in the Node runtime, which is the only place with a
    // resolver — see convex/jobImportFetch.ts for why that matters here.
    const html: string = await ctx.runAction(
      internal.jobImportFetch.fetchJobPage,
      { url: args.url },
    )
    // Two readings of the same page, because a board that renders its ads
    // client-side leaves nothing in the markup but chrome while still
    // publishing the whole ad as JSON-LD for Google for Jobs. Take whichever
    // actually carries the ad rather than assuming the page is server
    // rendered — that assumption is what made Welcome to the Jungle and every
    // other React job board answer `page_too_thin`.
    const structured = jobPostingText(html)
    const visible = htmlToText(html)
    const pageText = structured.length > visible.length ? structured : visible
    // Below this, the page was almost certainly a JS shell or a consent wall,
    // and a model handed 80 characters will invent an entire role.
    if (pageText.length < MIN_USABLE_TEXT) throw new ConvexError('page_too_thin')

    const questionCount = draftCount(
      args.questionCount,
      DEFAULT_QUESTION_COUNT,
      QUESTION_RANGE,
    )
    const criteriaCount = draftCount(
      args.criteriaCount,
      DEFAULT_CRITERIA_COUNT,
      CRITERIA_RANGE,
    )
    const { system, user } = jobImportPrompt({
      language: context.language,
      pageText,
      questionCount,
      criteriaCount,
    })

    const { value } = await complete({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      schema: draftSchema,
      schemaName: 'interview_draft',
      temperature: 0.4,
    })
    return value
  },
})

/**
 * Write the draft the recruiter accepted, in one transaction. The dialog used
 * to create each question and criterion in its own call, so a failure on the
 * fifth left a role half-imported with nothing saying what had been written
 * (audit 2026-09-15, recruiter F9). Every row passes the same rules as one
 * added by hand, and either all of them land or none does.
 */
export const applyDraft = mutation({
  args: {
    projectId: v.id('projects'),
    questions: v.array(v.object({ title: v.string(), content: v.string() })),
    criteria: v.array(
      v.object({
        label: v.string(),
        description: v.string(),
        weight: v.number(),
      }),
    ),
  },
  handler: async (ctx, { projectId, questions, criteria }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    await appendQuestions(ctx, project, questions)
    await appendCriteria(ctx, project, criteria)
    return null
  },
})
