/**
 * A role's public candidate link: `/apply/<applyToken>`.
 *
 * The link opens nothing by itself. It lets whoever holds it type a name and
 * an address and get a session of their own — the same row an invitation
 * creates — and from there the candidate is on `/s/<token>` like any other.
 *
 * What an open door costs, and how this bounds it:
 *  - The address is declared, not proven. No mail is sent on submission, so
 *    the form cannot be used to mail arbitrary addresses from our domain.
 *  - Every submission is a new session. Handing back an existing one for an
 *    address would hand anyone who knows that address its owner's interview.
 *  - Sessions per role are rate-limited, and the role's own state (active,
 *    before its deadline, organisation not being deleted) opens and closes
 *    the link.
 * See KNOWN_ISSUES.md § "The public apply link".
 */

import { ConvexError, v } from 'convex/values'

import { mutation, query } from './_generated/server'
import { languageValidator } from './schema'
import { effectiveNow } from './lib/clock'
import { isPastDeadline } from './lib/sessionState'
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

/** Same order and meaning as `evaluateSessionGate`, for a role alone. */
function applyState(
  project: Doc<'projects'>,
  org: Doc<'organizations'>,
  now: number,
): 'ready' | 'closed' | 'expired' {
  if (org.deletingAt !== undefined) return 'closed'
  if (isPastDeadline(project, now)) return 'expired'
  if (project.status !== 'active') return 'closed'
  return 'ready'
}

export const landing = query({
  args: { token: v.string(), now: v.number() },
  returns: v.object({
    organisationName: v.string(),
    jobTitle: v.union(v.string(), v.null()),
    language: languageValidator,
    maxDurationMinutes: v.number(),
    state: v.union(
      v.literal('ready'),
      v.literal('closed'),
      v.literal('expired'),
    ),
  }),
  handler: async (ctx, { token, now }) => {
    const { project, org } = await requireApplyProject(ctx, token)
    return {
      organisationName: org.name,
      jobTitle: project.jobTitle ?? null,
      language: project.language,
      maxDurationMinutes: project.maxDurationMinutes,
      state: applyState(project, org, effectiveNow(now)),
    }
  },
})

/** Open a session on the role and hand its token to the candidate. */
export const start = mutation({
  args: { token: v.string(), name: v.string(), email: v.string() },
  returns: v.object({ sessionToken: v.string() }),
  handler: async (ctx, { token, name, email }) => {
    const { project, org } = await requireApplyProject(ctx, token)
    // The same codes the candidate's own page uses for a closed interview.
    const state = applyState(project, org, Date.now())
    if (state === 'closed') throw new ConvexError('closed')
    if (state === 'expired') throw new ConvexError('expired')
    const candidate = normalizeCandidate({ name, email })
    await consumeLimit(ctx, 'candidateApply', project._id)
    const { accessToken } = await insertSession(ctx, project, candidate)
    await ctx.db.patch('projects', project._id, {
      sessionCount: project.sessionCount + 1,
    })
    return { sessionToken: accessToken }
  },
})
