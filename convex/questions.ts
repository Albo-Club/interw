import { ConvexError, v } from 'convex/values'

import { mutation } from './_generated/server'
import { requireProjectEditable } from './lib/projectAccess'
import type { GenericMutationCtx } from 'convex/server'
import type { DataModel, Id } from './_generated/dataModel'

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

export const create = mutation({
  args: {
    projectId: v.id('projects'),
    content: v.string(),
    title: v.optional(v.string()),
    hintText: v.optional(v.string()),
    maxResponseSeconds: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectEditable(ctx, args.projectId)

    const existing = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', args.projectId))
      .collect()
    if (existing.length >= MAX_QUESTIONS) throw new ConvexError('too_many_questions')

    const content = args.content.trim()
    if (!content || content.length > CONTENT_MAX) {
      throw new ConvexError('invalid_content')
    }
    const title = args.title?.trim()
    if (title && title.length > TITLE_MAX) throw new ConvexError('invalid_title')
    const hint = args.hintText?.trim()
    if (hint && hint.length > HINT_MAX) throw new ConvexError('hint_too_long')

    return await ctx.db.insert('questions', {
      orgId: project.orgId,
      projectId: args.projectId,
      orderIndex: existing.length,
      title: title || undefined,
      content,
      hintText: hint || undefined,
      maxResponseSeconds: validateResponseSeconds(
        args.maxResponseSeconds ?? DEFAULT_RESPONSE_SECONDS,
      ),
    })
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

/**
 * Per-question criterion weighting: which criteria this answer speaks to, and
 * how strongly. Absent means "all criteria, evenly".
 */
export const setCriteriaWeights = mutation({
  args: {
    questionId: v.id('questions'),
    weights: v.array(
      v.object({ criterionId: v.id('criteria'), weight: v.number() }),
    ),
  },
  handler: async (ctx, { questionId, weights }) => {
    const question = await loadQuestionForEdit(ctx, questionId)

    if (weights.length === 0) {
      await ctx.db.patch('questions', questionId, {
        criteriaWeights: undefined,
      })
      return null
    }

    const record: Record<Id<'criteria'>, number> = {}
    for (const { criterionId, weight } of weights) {
      const criterion = await ctx.db.get('criteria', criterionId)
      if (!criterion || criterion.projectId !== question.projectId) {
        throw new ConvexError('unknown_criterion')
      }
      if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
        throw new ConvexError('invalid_weight')
      }
      record[criterionId] = weight
    }
    await ctx.db.patch('questions', questionId, { criteriaWeights: record })
    return null
  },
})
