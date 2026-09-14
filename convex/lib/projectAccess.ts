/**
 * Who may see and edit a project.
 *
 * Two layers, in this order, and never one without the other:
 *   1. Organisation membership — the hard boundary. Enforced by
 *      `requireOrgMember`, which every entry point here calls first.
 *   2. Project visibility — a soft boundary inside the org. A project with
 *      `projectShares` rows is visible only to those people, its creator, and
 *      org admins/owners. Invisible resolves to `not_found`, not "forbidden":
 *      a recruiter should not learn that a confidential role exists.
 */

import { ConvexError } from 'convex/values'

import { requireOrgMember } from './auth'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { AppRole } from './auth'
import type { DataModel, Doc, Id } from '../_generated/dataModel'

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>

/** Admins and owners see every project in their organisation. */
function seesEverything(role: AppRole): boolean {
  return role === 'admin' || role === 'owner'
}

export async function canSeeProject(
  ctx: Ctx,
  project: Doc<'projects'>,
  userId: Id<'users'>,
  role: AppRole,
): Promise<boolean> {
  if (!project.restricted) return true
  if (seesEverything(role)) return true
  if (project.createdBy === userId) return true
  const share = await ctx.db
    .query('projectShares')
    .withIndex('by_project_and_user', (q) =>
      q.eq('projectId', project._id).eq('userId', userId),
    )
    .unique()
  return share !== null
}

/**
 * Resolve a project the caller is allowed to read, or throw. Every project
 * query and mutation starts here — the org check is not something a handler
 * is trusted to remember.
 */
export async function requireProjectAccess(
  ctx: Ctx,
  projectId: Id<'projects'>,
): Promise<{
  project: Doc<'projects'>
  user: Doc<'users'>
  member: Doc<'organizationMembers'>
}> {
  const project = await ctx.db.get('projects', projectId)
  if (!project) throw new ConvexError('not_found')
  const { user, member } = await requireOrgMember(ctx, project.orgId)
  if (!(await canSeeProject(ctx, project, user._id, member.role))) {
    throw new ConvexError('not_found')
  }
  return { project, user, member }
}

/**
 * Same, for writes. Anyone who can see a project can edit it — an org is a
 * team, not a hierarchy — but archived projects are frozen: editing one
 * silently changes what past candidates were asked.
 */
export async function requireProjectEditable(
  ctx: Ctx,
  projectId: Id<'projects'>,
): Promise<{
  project: Doc<'projects'>
  user: Doc<'users'>
  member: Doc<'organizationMembers'>
}> {
  const access = await requireProjectAccess(ctx, projectId)
  if (access.project.status === 'archived') {
    throw new ConvexError('project_archived')
  }
  return access
}

/** Destructive actions (delete, change who the project is restricted to). */
export async function requireProjectOwnerOrAdmin(
  ctx: Ctx,
  projectId: Id<'projects'>,
): Promise<{
  project: Doc<'projects'>
  user: Doc<'users'>
  member: Doc<'organizationMembers'>
}> {
  const access = await requireProjectAccess(ctx, projectId)
  if (
    !seesEverything(access.member.role) &&
    access.project.createdBy !== access.user._id
  ) {
    throw new ConvexError('insufficient_role')
  }
  return access
}

/**
 * Narrow an already-org-scoped list to what this user may see, with one query
 * for the whole list rather than one per project.
 */
export async function filterVisibleProjects(
  ctx: Ctx,
  projects: Array<Doc<'projects'>>,
  userId: Id<'users'>,
  role: AppRole,
): Promise<Array<Doc<'projects'>>> {
  if (seesEverything(role)) return projects
  const needsCheck = projects.some((p) => p.restricted)
  if (!needsCheck) return projects
  const shares = await ctx.db
    .query('projectShares')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  const shared = new Set(shares.map((s) => s.projectId))
  return projects.filter(
    (p) => !p.restricted || p.createdBy === userId || shared.has(p._id),
  )
}
