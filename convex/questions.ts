import { ConvexError, v } from 'convex/values'

import { mutation } from './_generated/server'
import { internal } from './_generated/api'
import { questionSlotKeys } from './media'
import { requireProjectEditable } from './lib/projectAccess'
import type { GenericMutationCtx } from 'convex/server'
import type { DataModel, Doc, Id } from './_generated/dataModel'

const CONTENT_MAX = 1_000
const TITLE_MAX = 120
const HINT_MAX = 300
const MIN_RESPONSE_SECONDS = 15
const MAX_RESPONSE_SECONDS = 600
const DEFAULT_RESPONSE_SECONDS = 120
const MAX_QUESTIONS = 25

async function loadQuestionForEdit(
  ctx: GenericMutationCtx<DataModel>,
  questionId: Id<'questions'>,
) {
  const question = await ctx.db.get('questions', questionId)
  if (!question) throw new ConvexError('not_found')
  await requireProjectEditable(ctx, question.projectId)
  return question
}

/**
 * Refuse to renumber the trame once anyone has answered it.
 *
 * Deleting or reordering a question rewrites every following `orderIndex`.
 * Answers already recorded keep the index they were recorded under, and while
 * the joins downstream now resolve by `questionId` and are safe, the numbering
 * a candidate saw ("question 3 of 7") and the one the next candidate sees stop
 * agreeing — on the same role, mid-campaign. Editing a question's text is
 * still allowed: that changes what was asked, not which answer belongs to it.
 */
async function requireNoSessions(
  ctx: GenericMutationCtx<DataModel>,
  projectId: Id<'projects'>,
): Promise<void> {
  const project = await ctx.db.get('projects', projectId)
  if (!project) throw new ConvexError('not_found')
  if (project.sessionCount > 0) throw new ConvexError('project_has_sessions')
}

function validateResponseSeconds(seconds: number): number {
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_RESPONSE_SECONDS ||
    seconds > MAX_RESPONSE_SECONDS
  ) {
    throw new ConvexError('invalid_response_seconds')
  }
  return seconds
}

export type QuestionInput = {
  content: string
  title?: string
  hintText?: string
  maxResponseSeconds?: number
}

/**
 * Validate every question, then append them after the role's existing ones.
 * Shared by `create` and the job-ad import, so a question enters the trame
 * through one set of rules whichever button wrote it. Throws before the first
 * insert on a count overflow; a later validation failure aborts the enclosing
 * mutation, so nothing is half-written either way.
 */
export async function appendQuestions(
  ctx: GenericMutationCtx<DataModel>,
  project: Doc<'projects'>,
  inputs: Array<QuestionInput>,
): Promise<Array<Id<'questions'>>> {
  const existing = await ctx.db
    .query('questions')
    .withIndex('by_project', (q) => q.eq('projectId', project._id))
    .collect()
  if (existing.length + inputs.length > MAX_QUESTIONS) {
    throw new ConvexError('too_many_questions')
  }

  const ids: Array<Id<'questions'>> = []
  for (const input of inputs) {
    const content = input.content.trim()
    if (!content || content.length > CONTENT_MAX) {
      throw new ConvexError('invalid_content')
    }
    const title = input.title?.trim()
    if (title && title.length > TITLE_MAX) throw new ConvexError('invalid_title')
    const hint = input.hintText?.trim()
    if (hint && hint.length > HINT_MAX) throw new ConvexError('hint_too_long')

    ids.push(
      await ctx.db.insert('questions', {
        orgId: project.orgId,
        projectId: project._id,
        orderIndex: existing.length + ids.length,
        title: title || undefined,
        content,
        hintText: hint || undefined,
        maxResponseSeconds: validateResponseSeconds(
          input.maxResponseSeconds ?? DEFAULT_RESPONSE_SECONDS,
        ),
      }),
    )
  }
  return ids
}

export const create = mutation({
  args: {
    projectId: v.id('projects'),
    content: v.string(),
    title: v.optional(v.string()),
    hintText: v.optional(v.string()),
    maxResponseSeconds: v.optional(v.number()),
  },
  handler: async (ctx, { projectId, ...input }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    const [id] = await appendQuestions(ctx, project, [input])
    return id
  },
})

export const update = mutation({
  args: {
    questionId: v.id('questions'),
    content: v.optional(v.string()),
    title: v.optional(v.string()),
    hintText: v.optional(v.string()),
    maxResponseSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await loadQuestionForEdit(ctx, args.questionId)
    const patch: Record<string, unknown> = {}

    if (args.content !== undefined) {
      const content = args.content.trim()
      if (!content || content.length > CONTENT_MAX) {
        throw new ConvexError('invalid_content')
      }
      patch.content = content
    }
    if (args.title !== undefined) {
      const title = args.title.trim()
      if (title.length > TITLE_MAX) throw new ConvexError('invalid_title')
      patch.title = title || undefined
    }
    if (args.hintText !== undefined) {
      const hint = args.hintText.trim()
      if (hint.length > HINT_MAX) throw new ConvexError('hint_too_long')
      patch.hintText = hint || undefined
    }
    if (args.maxResponseSeconds !== undefined) {
      patch.maxResponseSeconds = validateResponseSeconds(args.maxResponseSeconds)
    }

    await ctx.db.patch('questions', args.questionId, patch)
    return null
  },
})

export const remove = mutation({
  args: { questionId: v.id('questions') },
  handler: async (ctx, { questionId }) => {
    const question = await loadQuestionForEdit(ctx, questionId)
    await requireNoSessions(ctx, question.projectId)
    await ctx.db.delete('questions', questionId)
    // Its recording went with the row only in name: the object stayed in the
    // bucket with nothing left to find it by. The row is gone, so every key
    // its slot could have issued is deleted now.
    await ctx.scheduler.runAfter(0, internal.media.deleteKeys, {
      keys: [
        ...new Set([
          ...questionSlotKeys(question),
          ...(question.mediaKey ? [question.mediaKey] : []),
        ]),
      ],
    })

    // Close the gap so indexes stay 0..n-1: the candidate engine walks them by
    // position, and a hole would end the interview early.
    const rest = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', question.projectId))
      .collect()
    for (const [index, row] of rest.entries()) {
      if (row.orderIndex !== index) {
        await ctx.db.patch('questions', row._id, { orderIndex: index })
      }
    }
    return null
  },
})

/** Reorder by listing every question id in the order wanted. */
export const reorder = mutation({
  args: {
    projectId: v.id('projects'),
    orderedIds: v.array(v.id('questions')),
  },
  handler: async (ctx, { projectId, orderedIds }) => {
    await requireProjectEditable(ctx, projectId)
    await requireNoSessions(ctx, projectId)
    const existing = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()

    // Reject a partial list rather than reindex around it: a dropped id would
    // silently delete a question from the interview order.
    if (
      existing.length !== orderedIds.length ||
      new Set(orderedIds).size !== orderedIds.length
    ) {
      throw new ConvexError('incomplete_order')
    }
    const known = new Set(existing.map((q) => q._id as string))
    for (const id of orderedIds) {
      if (!known.has(id)) throw new ConvexError('unknown_question')
    }

    for (const [index, id] of orderedIds.entries()) {
      await ctx.db.patch('questions', id, { orderIndex: index })
    }
    return null
  },
})
