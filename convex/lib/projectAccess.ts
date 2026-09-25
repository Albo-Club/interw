/**
 * Who may see and edit a project.
 *
 * Two layers, in this order, and never one without the other:
 *   1. Organisation membership — the hard boundary. Enforced by
 *      `requireOrgMember`, which every entry point here calls first.
 *   2. Project visibility — a soft boundary inside the org. Every role is
 *      visible to its team (its creator plus the `projectShares` rows) and to
 *      org admins/owners, and to nobody else. Invisible resolves to
 *      `not_found`, not "forbidden": a recruiter should not learn that a
 *      confidential role exists.
 *
 * The creator is on the team by construction and is never stored as a row:
 * they cannot be dropped from it, so the person who opened the search always
 * sees it and always hears about its reports. That seat belongs to the
 * membership the role was created in (`isCreator`): removal ends it, and a
 * re-invitation does not bring it back (T17-2).
 */

import { ConvexError } from 'convex/values'

import { requireOrgMember } from './auth'
import type { GenericMutationCtx, GenericQueryCtx } from 'convex/server'
import type { AppRole } from './auth'
import type { DataModel, Doc, Id } from '../_generated/dataModel'

type Ctx = GenericQueryCtx<DataModel> | GenericMutationCtx<DataModel>
type Viewer = Pick<Doc<'organizationMembers'>, 'userId' | 'role' | 'joinedAt'>

/** Admins and owners see every project in their organisation. */
function seesEverything(role: AppRole): boolean {
  return role === 'admin' || role === 'owner'
}

/**
 * Created the role during their current membership. `createdBy` alone would
 * outlive a removal: a former member re-invited as a plain member would get
 * back every role they created, owner-tier actions included. A role can only
 * be created by a member, so `createdAt >= joinedAt` means "this membership".
 */
export function isCreator(
  project: Pick<Doc<'projects'>, 'createdBy' | 'createdAt'>,
  member: Pick<Doc<'organizationMembers'>, 'userId' | 'joinedAt'>,
): boolean {
  return (
    project.createdBy === member.userId && project.createdAt >= member.joinedAt
  )
}

export async function canSeeProject(
  ctx: Ctx,
  project: Doc<'projects'>,
  member: Viewer,
): Promise<boolean> {
  if (seesEverything(member.role)) return true
  if (isCreator(project, member)) return true
  const share = await ctx.db
    .query('projectShares')
    .withIndex('by_project_and_user', (q) =>
      q.eq('projectId', project._id).eq('userId', member.userId),
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
  if (!(await canSeeProject(ctx, project, member))) {
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

/** Destructive actions (delete, archive, change the role's team). */
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
    !isCreator(access.project, access.member)
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
  member: Viewer,
): Promise<Array<Doc<'projects'>>> {
  if (seesEverything(member.role)) return projects
  const shared = await sharedProjectIds(ctx, member.userId)
  return projects.filter((p) => isCreator(p, member) || shared.has(p._id))
}

/** Roles this person was added to the team of. Their own roles, whose team
 *  they are on as creator, are not in it: use `isCreator` for those. */
export async function sharedProjectIds(
  ctx: Ctx,
  userId: Id<'users'>,
): Promise<Set<Id<'projects'>>> {
  const shares = await ctx.db
    .query('projectShares')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  return new Set(shares.map((s) => s.projectId))
}

/**
 * Revoke what a person holds in an organisation only because they belong to
 * it: their places on role teams, and the report links they handed out (h03).
 * A link acts for its creator; once that person has left, nobody accountable
 * is behind it. Called when a membership ends (`removeMember`, one org) and
 * when the account goes (`cascadeDelete`, every org at once).
 */
export async function revokeMemberGrants(
  ctx: GenericMutationCtx<DataModel>,
  userId: Id<'users'>,
  orgId?: Id<'organizations'>,
): Promise<void> {
  const teamRows = await ctx.db
    .query('projectShares')
    .withIndex('by_user', (q) => q.eq('userId', userId))
    .collect()
  for (const row of teamRows) {
    if (orgId === undefined || row.orgId === orgId) {
      await ctx.db.delete('projectShares', row._id)
    }
  }

  const links = await ctx.db
    .query('reportShares')
    .withIndex('by_creator_and_org', (q) =>
      orgId === undefined
        ? q.eq('createdBy', userId)
        : q.eq('createdBy', userId).eq('orgId', orgId),
    )
    .collect()
  const now = Date.now()
  for (const link of links) {
    if (link.revokedAt === undefined) {
      await ctx.db.patch('reportShares', link._id, { revokedAt: now })
    }
  }
}
