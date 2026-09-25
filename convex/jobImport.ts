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

import { action, internalQuery } from './_generated/server'
import { internal } from './_generated/api'
import { complete } from './lib/ai'
import { htmlToText, jobPostingText } from './lib/htmlText'
import { jobImportPrompt } from './lib/prompts'
import { requireProjectEditable } from './lib/projectAccess'
import { consumeLimit } from './rateLimiters'

const DEFAULT_QUESTION_COUNT = 6
const DEFAULT_CRITERIA_COUNT = 4
const MIN_USABLE_TEXT = 400

/** What the draft schema accepts, and so what a caller may ask the model for. */
const QUESTIONS = { min: 3, max: 15 }
const CRITERIA = { min: 2, max: 8 }

/**
 * A requested count, brought inside what the schema will accept. Asking the
 * model for a draft the schema then refuses only burns a paid call.
 */
function boundedCount(
  requested: number | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (requested === undefined) return fallback
  if (!Number.isFinite(requested)) throw new ConvexError('invalid_count')
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(requested)))
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
    .min(QUESTIONS.min)
    .max(QUESTIONS.max),
  criteria: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string().max(500),
        weight: z.number().int().min(1).max(100),
      }),
    )
    .min(CRITERIA.min)
    .max(CRITERIA.max),
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
    const questionCount = boundedCount(
      args.questionCount,
      DEFAULT_QUESTION_COUNT,
      QUESTIONS,
    )
    const criteriaCount = boundedCount(
      args.criteriaCount,
      DEFAULT_CRITERIA_COUNT,
      CRITERIA,
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
