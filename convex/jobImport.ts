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
import { htmlToText } from './lib/htmlText'
import { jobImportPrompt } from './lib/prompts'
import { requireProjectEditable } from './lib/projectAccess'
import { consumeLimit } from './rateLimiters'

const DEFAULT_QUESTION_COUNT = 6
const DEFAULT_CRITERIA_COUNT = 4
const MIN_USABLE_TEXT = 400
const FETCH_TIMEOUT_MS = 15_000

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
    .min(3)
    .max(15),
  criteria: z
    .array(
      z.object({
        label: z.string().min(1).max(80),
        description: z.string().max(500),
        weight: z.number().int().min(1).max(100),
      }),
    )
    .min(2)
    .max(8),
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

/**
 * Only http(s), and never a private address: this fetches a URL chosen by a
 * user from inside our infrastructure, which is a server-side request forgery
 * primitive if left open.
 */
function assertPublicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ConvexError('invalid_url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConvexError('invalid_url')
  }
  const host = url.hostname.toLowerCase()
  const isPrivate =
    host === 'localhost' ||
    host === '::1' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  if (isPrivate) throw new ConvexError('invalid_url')
  return url
}

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

    const url = assertPublicHttpUrl(args.url)
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'text/html,application/xhtml+xml' },
    })
    if (!response.ok) throw new ConvexError('page_unreachable')

    const pageText = htmlToText(await response.text())
    // Below this, the page was almost certainly a JS shell or a consent wall,
    // and a model handed 80 characters will invent an entire role.
    if (pageText.length < MIN_USABLE_TEXT) throw new ConvexError('page_too_thin')

    const questionCount = args.questionCount ?? DEFAULT_QUESTION_COUNT
    const criteriaCount = args.criteriaCount ?? DEFAULT_CRITERIA_COUNT
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
      tier: 'fast',
      temperature: 0.4,
    })
    return value
  },
})
