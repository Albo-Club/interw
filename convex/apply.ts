/**
 * A role's public candidate link: `/apply/<applyToken>`.
 *
 * Whoever holds it types a name and an address and gets a session of their
 * own — the same row an invitation creates — then continues on `/s/<token>`
 * like any other candidate. Why every submission is a new session, why no
 * mail is sent and how it is bounded: KNOWN_ISSUES.md § "The public apply
 * link".
 */

import { ConvexError, v } from 'convex/values'

import { mutation, query } from './_generated/server'
import { languageValidator } from './schema'
import { effectiveNow } from './lib/clock'
import { maxInterviewMinutes } from './lib/interviewDuration'
import { roleGate } from './lib/sessionState'
import { looksLikeToken } from './lib/tokens'
import { consumeLimit } from './rateLimiters'
import { insertSession, normalizeCandidate } from './sessions'
import type { GenericQueryCtx } from 'convex/server'
import type { DataModel, Doc } from './_generated/dataModel'

/** Resolve an apply token, failing identically for every one that does not. */
async function requireApplyProject(
  ctx: GenericQueryCtx<DataModel>,
  token: string,
): Promise<{ project: Doc<'projects'>; org: Doc<'organizations'> }> {
  if (!looksLikeToken(token)) throw new ConvexError('not_found')
  const project = await ctx.db
    .query('projects')
    .withIndex('by_apply_token', (q) => q.eq('applyToken', token))
    .unique()
  if (!project) throw new ConvexError('not_found')
  const org = await ctx.db.get('organizations', project.orgId)
  if (!org) throw new ConvexError('not_found')
  return { project, org }
}

export const landing = query({
  args: { token: v.string(), now: v.number() },
  returns: v.object({
    organisationName: v.string(),
    jobTitle: v.union(v.string(), v.null()),
    language: languageValidator,
    maxInterviewMinutes: v.number(),
    state: v.union(
      v.literal('ready'),
      v.literal('closed'),
      v.literal('expired'),
    ),
  }),
  handler: async (ctx, { token, now }) => {
    const { project, org } = await requireApplyProject(ctx, token)
    const questions = await ctx.db
      .query('questions')
      .withIndex('by_project', (q) => q.eq('projectId', project._id))
      .collect()
    return {
      organisationName: org.name,
      jobTitle: project.jobTitle ?? null,
      language: project.language,
      maxInterviewMinutes: maxInterviewMinutes(questions),
      state: roleGate(project, org, effectiveNow(now)) ?? ('ready' as const),
    }
  },
})

/** Open a session on the role and hand its token to the candidate. */
export const start = mutation({
  args: { token: v.string(), name: v.string(), email: v.string() },
  returns: v.object({ sessionToken: v.string() }),
  handler: async (ctx, { token, name, email }) => {
    const { project, org } = await requireApplyProject(ctx, token)
    // The same codes the candidate's own page uses for a closed interview,
    // spelled out so the error-copy parity test can read them.
    const closed = roleGate(project, org, Date.now())
    if (closed === 'closed') throw new ConvexError('closed')
    if (closed === 'expired') throw new ConvexError('expired')
    const candidate = normalizeCandidate({ name, email })
    await consumeLimit(ctx, 'candidateApply', project._id)
    const { accessToken } = await insertSession(ctx, project, candidate)
    await ctx.db.patch('projects', project._id, {
      sessionCount: project.sessionCount + 1,
    })
    return { sessionToken: accessToken }
  },
})
