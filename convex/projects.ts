import { ConvexError, v } from 'convex/values'

import { mutation, query } from './_generated/server'
import {
  candidateFieldsValidator,
  introModeValidator,
  languageValidator,
  projectStatusValidator,
} from './schema'
import { requireOrgMember, requireOrgRole } from './lib/auth'
import {
  filterVisibleProjects,
  requireProjectAccess,
  requireProjectEditable,
  requireProjectOwnerOrAdmin,
} from './lib/projectAccess'
import { uniqueSlug } from './lib/slug'
import { normalizeWeights } from './lib/weights'
import type { Doc } from './_generated/dataModel'

const TITLE_MAX = 120
const JOB_TITLE_MAX = 120
const INTRO_TEXT_MAX = 2_000
const PERSONA_NAME_MAX = 60
const MIN_DURATION_MINUTES = 5
const MAX_DURATION_MINUTES = 120

/**
 * Listing cap. A single organisation realistically runs tens of open roles;
 * 200 is a ceiling, not a page size. Sessions — which genuinely reach the
 * thousands — paginate instead.
 */
const LIST_CAP = 200

const DEFAULT_CANDIDATE_FIELDS = {
  phone: { enabled: false, required: false },
  linkedin: { enabled: false, required: false },
  cv: { enabled: true, required: false },
  coverLetter: { enabled: false, required: false },
} as const

function requireText(value: string, max: number, code: string): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) throw new ConvexError(code)
  return trimmed
}

function optionalText(
  value: string | undefined,
  max: number,
  code: string,
): string | undefined {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  if (trimmed.length > max) throw new ConvexError(code)
  return trimmed
}

/** The shape every project list renders. Deliberately excludes nothing
 *  sensitive — projects hold no candidate data — but stays small. */
function toSummary(project: Doc<'projects'>) {
  return {
    _id: project._id,
    slug: project.slug,
    title: project.title,
    jobTitle: project.jobTitle ?? null,
    status: project.status,
    language: project.language,
    createdAt: project.createdAt,
    createdBy: project.createdBy,
    expiresAt: project.expiresAt ?? null,
    restricted: project.restricted,
    sessionCount: project.sessionCount,
    completedSessionCount: project.completedSessionCount,
  }
}

export const list = query({
  args: {
    orgId: v.id('organizations'),
    status: v.optional(projectStatusValidator),
  },
  handler: async (ctx, { orgId, status }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    const rows = status
      ? await ctx.db
          .query('projects')
          .withIndex('by_org_and_status', (q) =>
            q.eq('orgId', orgId).eq('status', status),
          )
          .order('desc')
          .take(LIST_CAP)
      : await ctx.db
          .query('projects')
          .withIndex('by_org', (q) => q.eq('orgId', orgId))
          .order('desc')
          .take(LIST_CAP)
    const visible = await filterVisibleProjects(ctx, rows, user._id, member.role)
    return visible.map(toSummary)
  },
})

/**
 * Everything the project detail page and the wizard need, in one read:
 * the project, its questions in order, and its criteria with weights already
 * normalised so no caller has to remember to do it.
 */
export const getBySlug = query({
  args: { orgId: v.id('organizations'), slug: v.string() },
  handler: async (ctx, { orgId, slug }) => {
    const { user, member } = await requireOrgMember(ctx, orgId)
    const project = await ctx.db
      .query('projects')
      .withIndex('by_org_and_slug', (q) => q.eq('orgId', orgId).eq('slug', slug))
      .unique()
    if (!project) throw new ConvexError('not_found')
    const visible = await filterVisibleProjects(
      ctx,
      [project],
      user._id,
      member.role,
    )
    if (visible.length === 0) throw new ConvexError('not_found')

    const questions = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    const criteria = await ctx.db
      .query('criteria')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    const shares = await ctx.db
      .query('projectShares')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()

    return {
      project: {
        ...toSummary(project),
        personaName: project.personaName ?? null,
        introMode: project.introMode,
        introText: project.introText ?? null,
        hasIntroMedia: project.introMediaKey !== undefined,
        maxDurationMinutes: project.maxDurationMinutes,
        candidateFields: project.candidateFields,
      },
      questions: questions.map((q) => ({
        _id: q._id,
        orderIndex: q.orderIndex,
        title: q.title ?? null,
        content: q.content,
        hintText: q.hintText ?? null,
        maxResponseSeconds: q.maxResponseSeconds,
        mediaKind: q.mediaKind ?? null,
        hasMedia: q.mediaKey !== undefined,
      })),
      criteria: normalizeWeights(
        criteria.map((c) => ({
          _id: c._id,
          label: c.label,
          description: c.description ?? null,
          weight: c.weight,
          orderIndex: c.orderIndex,
        })),
      ),
      sharedWith: shares.map((s) => s.userId),
    }
  },
})

export const create = mutation({
  args: {
    orgId: v.id('organizations'),
    title: v.string(),
    jobTitle: v.optional(v.string()),
    language: languageValidator,
  },
  handler: async (ctx, { orgId, title, jobTitle, language }) => {
    const { user } = await requireOrgMember(ctx, orgId)
    const cleanTitle = requireText(title, TITLE_MAX, 'invalid_title')

    const existing = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(LIST_CAP)
    const slug = uniqueSlug(cleanTitle, new Set(existing.map((p) => p.slug)))

    return await ctx.db.insert('projects', {
      orgId,
      slug,
      title: cleanTitle,
      jobTitle: optionalText(jobTitle, JOB_TITLE_MAX, 'invalid_job_title'),
      status: 'draft',
      language,
      introMode: 'none',
      maxDurationMinutes: 20,
      candidateFields: DEFAULT_CANDIDATE_FIELDS,
      createdBy: user._id,
      createdAt: Date.now(),
      restricted: false,
      sessionCount: 0,
      completedSessionCount: 0,
    })
  },
})

export const update = mutation({
  args: {
    projectId: v.id('projects'),
    title: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    language: v.optional(languageValidator),
    personaName: v.optional(v.string()),
    introMode: v.optional(introModeValidator),
    introText: v.optional(v.string()),
    maxDurationMinutes: v.optional(v.number()),
    candidateFields: v.optional(candidateFieldsValidator),
    /** Epoch ms, or null to clear. */
    expiresAt: v.optional(v.union(v.number(), v.null())),
  },
  handler: async (ctx, args) => {
    const { project } = await requireProjectEditable(ctx, args.projectId)
    const patch: Partial<Doc<'projects'>> = {}

    if (args.title !== undefined) {
      patch.title = requireText(args.title, TITLE_MAX, 'invalid_title')
    }
    if (args.jobTitle !== undefined) {
      patch.jobTitle = optionalText(
        args.jobTitle,
        JOB_TITLE_MAX,
        'invalid_job_title',
      )
    }
    if (args.language !== undefined) patch.language = args.language
    if (args.personaName !== undefined) {
      patch.personaName = optionalText(
        args.personaName,
        PERSONA_NAME_MAX,
        'invalid_persona_name',
      )
    }
    if (args.introMode !== undefined) patch.introMode = args.introMode
    if (args.introText !== undefined) {
      patch.introText = optionalText(
        args.introText,
        INTRO_TEXT_MAX,
        'intro_too_long',
      )
    }
    if (args.maxDurationMinutes !== undefined) {
      if (
        !Number.isInteger(args.maxDurationMinutes) ||
        args.maxDurationMinutes < MIN_DURATION_MINUTES ||
        args.maxDurationMinutes > MAX_DURATION_MINUTES
      ) {
        throw new ConvexError('invalid_duration')
      }
      patch.maxDurationMinutes = args.maxDurationMinutes
    }
    if (args.candidateFields !== undefined) {
      patch.candidateFields = args.candidateFields
    }
    if (args.expiresAt !== undefined) {
      if (args.expiresAt !== null && args.expiresAt <= Date.now()) {
        throw new ConvexError('expiry_in_the_past')
      }
      patch.expiresAt = args.expiresAt ?? undefined
    }

    await ctx.db.patch('projects', project._id, patch)
    return null
  },
})

/**
 * Draft → active. A project with no question cannot be published: a candidate
 * would receive a link to an empty interview, which is worse than an error.
 */
export const publish = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    const question = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .first()
    if (!question) throw new ConvexError('no_questions')
    if (project.status !== 'active') {
      await ctx.db.patch('projects', projectId, { status: 'active' })
    }
    return null
  },
})

export const archive = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectAccess(ctx, projectId)
    if (project.status === 'archived') return null
    await ctx.db.patch('projects', projectId, {
      status: 'archived',
      archivedAt: Date.now(),
    })
    return null
  },
})

export const restore = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectAccess(ctx, projectId)
    if (project.status !== 'archived') return null
    // Back to draft, never straight to active: the reason it was archived may
    // still hold, and re-publishing is one deliberate click.
    await ctx.db.patch('projects', projectId, {
      status: 'draft',
      archivedAt: undefined,
    })
    return null
  },
})

/**
 * Hard delete, for a project created by mistake.
 *
 * Refused once anyone has been invited: deleting it would orphan candidate
 * recordings and reports. Archiving is the answer there, and the error says so.
 */
export const remove = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectOwnerOrAdmin(ctx, projectId)
    if (project.sessionCount > 0) throw new ConvexError('project_has_sessions')

    for (const table of ['questions', 'criteria'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_project', (q) => q.eq('projectId', projectId))
        .collect()
      for (const row of rows) await ctx.db.delete(table, row._id)
    }
    const shares = await ctx.db
      .query('projectShares')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    for (const share of shares) await ctx.db.delete('projectShares', share._id)

    await ctx.db.delete('projects', projectId)
    return null
  },
})

/**
 * Restrict a project to named colleagues, or open it back up to the whole
 * organisation with an empty list.
 */
export const setShares = mutation({
  args: { projectId: v.id('projects'), userIds: v.array(v.id('users')) },
  handler: async (ctx, { projectId, userIds }) => {
    const { project, user } = await requireProjectOwnerOrAdmin(ctx, projectId)

    // Everyone named must already be a member of this organisation — sharing
    // must never become a side door into another org's data.
    for (const userId of userIds) {
      const member = await ctx.db
        .query('organizationMembers')
        .withIndex('by_org_and_user', (q) =>
          q.eq('orgId', project.orgId).eq('userId', userId),
        )
        .unique()
      if (!member) throw new ConvexError('not_a_member')
    }

    const existing = await ctx.db
      .query('projectShares')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    const wanted = new Set(userIds)
    for (const share of existing) {
      if (!wanted.has(share.userId)) {
        await ctx.db.delete('projectShares', share._id)
      } else {
        wanted.delete(share.userId)
      }
    }
    for (const userId of wanted) {
      await ctx.db.insert('projectShares', {
        orgId: project.orgId,
        projectId,
        userId,
        grantedBy: user._id,
        grantedAt: Date.now(),
      })
    }

    await ctx.db.patch('projects', projectId, {
      restricted: userIds.length > 0,
    })
    return null
  },
})

/** Org members, for the "share with" picker. */
export const shareCandidates = query({
  args: { orgId: v.id('organizations') },
  handler: async (ctx, { orgId }) => {
    await requireOrgRole(ctx, orgId, 'member')
    const members = await ctx.db
      .query('organizationMembers')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .take(200)
    return await Promise.all(
      members.map(async (m) => {
        const u = await ctx.db.get('users', m.userId)
        return {
          userId: m.userId,
          name: u?.name ?? null,
          email: u?.email ?? '',
          role: m.role,
        }
      }),
    )
  },
})
