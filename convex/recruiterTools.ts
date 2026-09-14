/**
 * What the in-app assistant may do with recruiting data.
 *
 * READ ONLY, deliberately. The assistant can find a candidate, read a report
 * and summarise a shortlist; it cannot set a decision, invite anyone, or
 * change a role. A hiring decision must never be reachable as a tool call —
 * not because the model would necessarily get it wrong, but because the
 * person accountable for it has to be the one who made it.
 *
 * Every tool re-derives org membership from the thread scope (see
 * lib/agentScope.ts) and re-applies project visibility, so a confidential
 * role does not become readable just because it was asked about in a chat.
 */

import { ConvexError, v } from 'convex/values'
import { createTool } from '@convex-dev/agent'
import { z } from 'zod/v3'

import { internal } from './_generated/api'
import { internalQuery } from './_generated/server'
import { parseScope, readMembership } from './lib/agentScope'
import { canSeeProject } from './lib/projectAccess'
import { normalizeWeights } from './lib/weights'
import type { Id } from './_generated/dataModel'

const LIST_CAP = 50

export const listRolesInternal = internalQuery({
  args: { orgId: v.id('organizations'), actorUserId: v.id('users') },
  handler: async (ctx, { orgId, actorUserId }) => {
    const member = await readMembership(ctx, orgId, actorUserId)
    const projects = await ctx.db
      .query('projects')
      .withIndex('by_org', (q) => q.eq('orgId', orgId))
      .order('desc')
      .take(LIST_CAP)

    const visible = []
    for (const project of projects) {
      if (!(await canSeeProject(ctx, project, actorUserId, member.role))) continue
      visible.push({
        projectId: project._id,
        slug: project.slug,
        title: project.title,
        jobTitle: project.jobTitle ?? null,
        status: project.status,
        candidates: project.sessionCount,
        completed: project.completedSessionCount,
      })
    }
    return visible
  },
})

export const listCandidatesInternal = internalQuery({
  args: {
    orgId: v.id('organizations'),
    actorUserId: v.id('users'),
    projectSlug: v.optional(v.string()),
  },
  handler: async (ctx, { orgId, actorUserId, projectSlug }) => {
    const member = await readMembership(ctx, orgId, actorUserId)

    let sessions
    if (projectSlug) {
      const project = await ctx.db
        .query('projects')
        .withIndex('by_org_and_slug', (q) =>
          q.eq('orgId', orgId).eq('slug', projectSlug),
        )
        .unique()
      if (!project) throw new ConvexError('not_found')
      if (!(await canSeeProject(ctx, project, actorUserId, member.role))) {
        throw new ConvexError('not_found')
      }
      sessions = await ctx.db
        .query('sessions')
        .withIndex('by_project', (q) => q.eq('projectId', project._id))
        .order('desc')
        .take(LIST_CAP)
    } else {
      sessions = await ctx.db
        .query('sessions')
        .withIndex('by_org', (q) => q.eq('orgId', orgId))
        .order('desc')
        .take(LIST_CAP)
    }

    const rows = []
    for (const session of sessions) {
      const project = await ctx.db.get('projects', session.projectId)
      if (!project) continue
      if (!(await canSeeProject(ctx, project, actorUserId, member.role))) continue
      const report = await ctx.db
        .query('reports')
        .withIndex('by_session', (q) => q.eq('sessionId', session._id))
        .unique()
      rows.push({
        sessionId: session._id,
        candidateName: session.candidateName,
        role: project.jobTitle ?? project.title,
        status: session.status,
        score: report?.overallScore ?? null,
        recommendation: report?.recommendation ?? null,
        recruiterDecision: session.recruiterDecision ?? null,
      })
    }
    return rows
  },
})

export const readReportInternal = internalQuery({
  args: {
    orgId: v.id('organizations'),
    actorUserId: v.id('users'),
    sessionId: v.id('sessions'),
  },
  handler: async (ctx, { orgId, actorUserId, sessionId }) => {
    const member = await readMembership(ctx, orgId, actorUserId)
    const session = await ctx.db.get('sessions', sessionId)
    // Scoping to the caller's org before anything else: a session id is
    // guessable in principle, and an assistant is a convenient oracle.
    if (!session || session.orgId !== orgId) throw new ConvexError('not_found')
    const project = await ctx.db.get('projects', session.projectId)
    if (!project) throw new ConvexError('not_found')
    if (!(await canSeeProject(ctx, project, actorUserId, member.role))) {
      throw new ConvexError('not_found')
    }

    const report = await ctx.db
      .query('reports')
      .withIndex('by_session', (q) => q.eq('sessionId', sessionId))
      .unique()
    if (!report) {
      return {
        candidateName: session.candidateName,
        status: session.status,
        report: null,
      }
    }

    const criteria = normalizeWeights(
      (
        await ctx.db
          .query('criteria')
          .withIndex('by_project', (q) => q.eq('projectId', project._id))
          .collect()
      ).map((criterion) => ({
        _id: criterion._id,
        label: criterion.label,
        weight: criterion.weight,
      })),
    )
    const labelById = new Map(criteria.map((c) => [c._id, c]))

    return {
      candidateName: session.candidateName,
      status: session.status,
      report: {
        overallScore: report.overallScore,
        recommendation: report.recommendation,
        summary: report.executiveSummary,
        strengths: report.strengths,
        concerns: report.concerns,
        criteria: report.criteriaScores.map((score) => ({
          label: labelById.get(score.criterionId)?.label ?? '',
          weight: labelById.get(score.criterionId)?.normalizedWeight ?? 0,
          score: score.score,
          rationale: score.rationale,
        })),
        recruiterDecision: session.recruiterDecision ?? null,
        recruiterNote: session.recruiterNote ?? null,
      },
    }
  },
})

const listRoles = createTool({
  description:
    'List the open roles in this organisation with how many candidates each ' +
    'has and how many have finished. Use this to resolve a role the user ' +
    'named loosely before calling any other tool.',
  inputSchema: z.object({}),
  execute: async (ctx): Promise<unknown> => {
    const { orgId, userId } = parseScope(ctx.userId)
    return await ctx.runQuery(internal.recruiterTools.listRolesInternal, {
      orgId,
      actorUserId: userId,
    })
  },
})

const listCandidates = createTool({
  description:
    'List candidates with their score, the automated recommendation and the ' +
    "recruiter's decision. Pass a role slug to narrow to one role; omit it " +
    'for the whole organisation. Read-only.',
  inputSchema: z.object({
    projectSlug: z
      .string()
      .optional()
      .describe('Slug of the role, from listRoles. Omit for all roles.'),
  }),
  execute: async (ctx, input): Promise<unknown> => {
    const { orgId, userId } = parseScope(ctx.userId)
    return await ctx.runQuery(internal.recruiterTools.listCandidatesInternal, {
      orgId,
      actorUserId: userId,
      projectSlug: input.projectSlug,
    })
  },
})

const readReport = createTool({
  description:
    "Read one candidate's full report: score, recommendation, summary, " +
    'strengths, concerns and the per-criterion reasoning. Use listCandidates ' +
    'first to get the session id. Read-only.',
  inputSchema: z.object({
    sessionId: z.string().describe('The session id from listCandidates'),
  }),
  execute: async (ctx, input): Promise<unknown> => {
    const { orgId, userId } = parseScope(ctx.userId)
    return await ctx.runQuery(internal.recruiterTools.readReportInternal, {
      orgId,
      actorUserId: userId,
      sessionId: input.sessionId as Id<'sessions'>,
    })
  },
})

export const recruiterTools = { listRoles, listCandidates, readReport }
