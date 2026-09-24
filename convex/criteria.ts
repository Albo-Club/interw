import { ConvexError, v } from 'convex/values'

import { mutation } from './_generated/server'
import { requireProjectEditable } from './lib/projectAccess'
import type { DataModel, Id } from './_generated/dataModel'
import type { GenericMutationCtx } from 'convex/server'

const LABEL_MAX = 80
const DESCRIPTION_MAX = 500
const MAX_CRITERIA = 12
const DEFAULT_WEIGHT = 10

async function loadCriterionForEdit(
  ctx: GenericMutationCtx<DataModel>,
  criterionId: Id<'criteria'>,
) {
  const criterion = await ctx.db.get('criteria', criterionId)
  if (!criterion) throw new ConvexError('not_found')
  await requireProjectEditable(ctx, criterion.projectId)
  return criterion
}

function validateWeight(weight: number): number {
  if (!Number.isFinite(weight) || weight < 0 || weight > 100) {
    throw new ConvexError('invalid_weight')
  }
  return weight
}

export const create = mutation({
  args: {
    projectId: v.id('projects'),
    label: v.string(),
    description: v.optional(v.string()),
    weight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectEditable(ctx, args.projectId)

    const existing = await ctx.db
      .query('criteria')
      .withIndex('by_project', (q) => q.eq('projectId', args.projectId))
      .collect()
    if (existing.length >= MAX_CRITERIA) throw new ConvexError('too_many_criteria')

    const label = args.label.trim()
    if (!label || label.length > LABEL_MAX) throw new ConvexError('invalid_label')
    const description = args.description?.trim()
    if (description && description.length > DESCRIPTION_MAX) {
      throw new ConvexError('description_too_long')
    }

    return await ctx.db.insert('criteria', {
      orgId: project.orgId,
      projectId: args.projectId,
      label,
      description: description || undefined,
      weight: validateWeight(args.weight ?? DEFAULT_WEIGHT),
      orderIndex: existing.length,
    })
  },
})

export const update = mutation({
  args: {
    criterionId: v.id('criteria'),
    label: v.optional(v.string()),
    description: v.optional(v.string()),
    weight: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await loadCriterionForEdit(ctx, args.criterionId)
    const patch: Record<string, unknown> = {}

    if (args.label !== undefined) {
      const label = args.label.trim()
      if (!label || label.length > LABEL_MAX) throw new ConvexError('invalid_label')
      patch.label = label
    }
    if (args.description !== undefined) {
      const description = args.description.trim()
      if (description.length > DESCRIPTION_MAX) {
        throw new ConvexError('description_too_long')
      }
      patch.description = description || undefined
    }
    if (args.weight !== undefined) patch.weight = validateWeight(args.weight)

    await ctx.db.patch('criteria', args.criterionId, patch)
    return null
  },
})

export const remove = mutation({
  args: { criterionId: v.id('criteria') },
  handler: async (ctx, { criterionId }) => {
    const criterion = await loadCriterionForEdit(ctx, criterionId)
    await ctx.db.delete('criteria', criterionId)

    const rest = await ctx.db
      .query('criteria')
      .withIndex('by_project', (q) => q.eq('projectId', criterion.projectId))
      .collect()
    for (const [index, row] of rest.entries()) {
      if (row.orderIndex !== index) {
        await ctx.db.patch('criteria', row._id, { orderIndex: index })
      }
    }
    return null
  },
})
