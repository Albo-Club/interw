import { ConvexError, v } from 'convex/values'

import { mutation, query } from './_generated/server'
import { internal } from './_generated/api'
import {
  candidateFieldsValidator,
  introModeValidator,
  languageValidator,
  projectStatusValidator,
} from './schema'
import { requireOrgMember, requireOrgRole } from './lib/auth'
import { effectiveIntroMode } from './lib/candidateView'
import { memberName } from './lib/memberName'
import {
  filterVisibleProjects,
  leaveTeam,
  requireProjectEditable,
  requireProjectOwnerOrAdmin,
  sharedProjectIds,
} from './lib/projectAccess'
import { publishBlockers } from './lib/publishReadiness'
import { uniqueSlug } from './lib/slug'
import { normalizeWeights } from './lib/weights'
import type { MutationCtx } from './_generated/server'
import type { Doc, Id } from './_generated/dataModel'

const TITLE_MAX = 120
const JOB_TITLE_MAX = 120
const PERSONA_NAME_MAX = 60

/**
 * Listing cap. A single organisation realistically runs tens of open roles;
 * 200 is a ceiling, not a page size. Sessions — which genuinely reach the
 * thousands — paginate instead.
 */
const LIST_CAP = 200

/** Largest team a caller may name (Back F7): every list we are handed is
 *  bounded, and a role followed by more than this is an org, not a team. */
const TEAM_MAX = 100

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
    // Owners and admins see every role but are emailed only about the ones
    // whose team they are on; the list says which (audit recruiter F6).
    const shared = await sharedProjectIds(ctx, user._id)
    return visible.map((project) => ({
      ...toSummary(project),
      onTeam: shared.has(project._id),
    }))
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
    // `.first()`, not `.unique()` (Back M4): Convex has no unique constraint,
    // and a duplicate slug written before `create` asked the index made
    // `.unique()` throw — on the page of both roles, for good. A degraded page
    // (the older role) beats an error on both.
    const project = await ctx.db
      .query('projects')
      .withIndex('by_org_and_slug', (q) => q.eq('orgId', orgId).eq('slug', slug))
      .first()
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

    return {
      project: {
        ...toSummary(project),
        personaName: project.personaName ?? null,
        introMode: effectiveIntroMode(project),
        hasIntroMedia: project.introMediaKey !== undefined,
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
    }
  },
})

export const create = mutation({
  args: {
    orgId: v.id('organizations'),
    /** What the candidate sees, and what the role is called unless… */
    jobTitle: v.string(),
    /** …the team gives it a label of its own, which only it ever sees. */
    internalTitle: v.optional(v.string()),
    language: languageValidator,
    /** Colleagues who follow the role, on top of the creator. */
    team: v.optional(v.array(v.id('users'))),
  },
  handler: async (
    ctx,
    { orgId, jobTitle, internalTitle, language, team },
  ) => {
    const { user } = await requireOrgMember(ctx, orgId)
    const cleanJobTitle = requireText(jobTitle, JOB_TITLE_MAX, 'invalid_title')
    const cleanTitle = internalTitle?.trim()
      ? requireText(internalTitle, TITLE_MAX, 'invalid_title')
      : cleanJobTitle

    const slug = await uniqueSlug(
      cleanTitle,
      async (candidate) =>
        (await ctx.db
          .query('projects')
          .withIndex('by_org_and_slug', (q) =>
            q.eq('orgId', orgId).eq('slug', candidate),
          )
          .first()) !== null,
    )

    const now = Date.now()
    const projectId = await ctx.db.insert('projects', {
      orgId,
      slug,
      title: cleanTitle,
      jobTitle: cleanJobTitle,
      status: 'draft',
      language,
      introMode: 'none',
      candidateFields: DEFAULT_CANDIDATE_FIELDS,
      createdBy: user._id,
      createdAt: now,
      sessionCount: 0,
      completedSessionCount: 0,
    })
    // The creator's seat is a row like anyone's (T17-2), so removal, which
    // deletes the rows, also takes it: `createdBy` alone grants nothing.
    await ctx.db.insert('projectShares', {
      orgId,
      projectId,
      userId: user._id,
      grantedBy: user._id,
      grantedAt: now,
    })
    if (team) {
      await writeTeam(
        ctx,
        { _id: projectId, orgId, createdBy: user._id },
        team,
        user._id,
      )
    }
    // The slug is derived here, so hand it back: the caller navigates to the
    // wizard next and should not have to guess or re-query for it.
    return { projectId, slug }
  },
})

export const update = mutation({
  args: {
    projectId: v.id('projects'),
    title: v.optional(v.string()),
    jobTitle: v.optional(v.string()),
    personaName: v.optional(v.string()),
    introMode: v.optional(introModeValidator),
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
      // A role with no internal name of its own is named by its job title,
      // and keeps being so as the job title changes.
      if (args.title === undefined && project.title === project.jobTitle) {
        patch.title = requireText(args.jobTitle, TITLE_MAX, 'invalid_title')
      }
    }
    if (args.personaName !== undefined) {
      patch.personaName = optionalText(
        args.personaName,
        PERSONA_NAME_MAX,
        'invalid_persona_name',
      )
    }
    if (args.introMode !== undefined) patch.introMode = args.introMode
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
 * Draft → active. Refused while `publishBlockers` names anything (M10): a
 * candidate would otherwise receive an empty interview, the wizard's example
 * question, or a score against a criterion nobody defined — each worse than
 * an error the recruiter can fix in a minute.
 */
export const publish = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectEditable(ctx, projectId)
    const questions = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    const criteria = await ctx.db
      .query('criteria')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    const blockers = publishBlockers(questions, criteria)
    if (blockers.length > 0) throw new ConvexError(blockers[0].code)
    if (project.status !== 'active') {
      await ctx.db.patch('projects', projectId, { status: 'active' })
    }
    return null
  },
})

/**
 * Archiving is the most destructive unprivileged action in this module, so it
 * is no longer unprivileged.
 *
 * `evaluateSessionGate` returns `closed` for any project that is not
 * `active`: archiving cuts the link of every candidate mid-interview, at once,
 * with no warning and no way for them to finish. It used to need only
 * `requireProjectAccess` — any member who could see the role — while deleting
 * an empty role needed owner or admin. The asymmetry was the wrong way round.
 */
export const archive = mutation({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectOwnerOrAdmin(ctx, projectId)
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
    // Same tier as `archive`: restoring lifts the freeze on the questions and,
    // through `publish`, reopens every candidate link the archival closed.
    const { project } = await requireProjectOwnerOrAdmin(ctx, projectId)
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

    // The recruiter's own recordings. Their face and their voice are personal
    // data too, and deleting only the rows left them in the bucket with
    // nothing pointing at them: unreachable by any later purge, billed
    // indefinitely, and removable only by hand.
    const keys: Array<string> = [...(project.pendingMediaKeys ?? [])]
    if (project.introMediaKey) keys.push(project.introMediaKey)

    for (const table of ['questions', 'criteria'] as const) {
      const rows = await ctx.db
        .query(table)
        .withIndex('by_project', (q) => q.eq('projectId', projectId))
        .collect()
      for (const row of rows) {
        if ('mediaKey' in row && row.mediaKey) keys.push(row.mediaKey)
        if ('pendingMediaKeys' in row && row.pendingMediaKeys) {
          keys.push(...row.pendingMediaKeys)
        }
        await ctx.db.delete(table, row._id)
      }
    }
    const shares = await ctx.db
      .query('projectShares')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    for (const share of shares) await ctx.db.delete('projectShares', share._id)

    await ctx.db.delete('projects', projectId)
    if (keys.length > 0) {
      await ctx.scheduler.runAfter(0, internal.media.deleteKeys, { keys })
    }
    return null
  },
})

/**
 * Replace a role's team with `userIds`. The creator's seat is never dropped
 * here, named or not: nobody unticks the person who opened the search. Once
 * removal has taken it, naming them puts them back like anyone else.
 */
async function writeTeam(
  ctx: MutationCtx,
  project: Pick<Doc<'projects'>, '_id' | 'orgId' | 'createdBy'>,
  userIds: Array<Id<'users'>>,
  grantedBy: Id<'users'>,
) {
  if (userIds.length > TEAM_MAX) throw new ConvexError('team_too_large')
  const wanted = new Set(userIds)

  // Everyone named must already be a member of this organisation — a team
  // must never become a side door into another org's data.
  for (const userId of wanted) {
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
    .withIndex('by_project', (q) => q.eq('projectId', project._id))
    .collect()
  for (const share of existing) {
    if (wanted.has(share.userId)) {
      wanted.delete(share.userId)
    } else if (share.userId !== project.createdBy) {
      await leaveTeam(ctx, share)
    }
  }
  for (const userId of wanted) {
    await ctx.db.insert('projectShares', {
      orgId: project.orgId,
      projectId: project._id,
      userId,
      grantedBy,
      grantedAt: Date.now(),
    })
  }
}

/**
 * The role's current team, for the dialog that edits it. The dialog starts
 * from this and cannot save before it has loaded (B8): `setTeam` takes the
 * whole list, so a dialog that opened empty used to wipe the team on save.
 */
export const team = query({
  args: { projectId: v.id('projects') },
  handler: async (ctx, { projectId }) => {
    const { project } = await requireProjectOwnerOrAdmin(ctx, projectId)
    const rows = await ctx.db
      .query('projectShares')
      .withIndex('by_project', (q) => q.eq('projectId', projectId))
      .collect()
    return {
      createdBy: project.createdBy,
      creator: await memberName(ctx, project.orgId, project.createdBy),
      members: rows.map((row) => row.userId),
    }
  },
})

/**
 * Set who follows the role. The team, plus org admins and owners, is who sees
 * it; the team alone is who is emailed when one of its reports is ready.
 */
export const setTeam = mutation({
  args: { projectId: v.id('projects'), userIds: v.array(v.id('users')) },
  handler: async (ctx, { projectId, userIds }) => {
    const { project, user } = await requireProjectOwnerOrAdmin(ctx, projectId)
    await writeTeam(ctx, project, userIds, user._id)
    return null
  },
})

/** Org members, for the team picker. */
export const teamCandidates = query({
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
