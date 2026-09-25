/**
 * Browser test fixtures (e2e/interview.spec.ts), kept out of the interview
 * engine so they cannot be mistaken for part of it.
 *
 * Internal, so only a deploy key reaches them, through `npx convex run`. The
 * org has no member who can sign in, and the candidate's address is Resend's
 * delivery sink: the completion email really goes out.
 *
 * A deploy key is not proof of a test deployment, so each fixture also refuses
 * unless the deployment opted in with `E2E_FIXTURES=enabled` — set on dev and
 * on staging (where CI runs the browser test), never on production. The flag
 * is an opt-in rather than an `APP_ENV` check because staging runs with
 * `APP_ENV=production`; see KNOWN_ISSUES.md § "E2E fixtures are opt-in per
 * deployment".
 */

import { ConvexError, v } from 'convex/values'

import { internalMutation, internalQuery } from './_generated/server'
import { sessionStatusValidator } from './schema'
import { generateToken } from './lib/tokens'

const E2E_ORG_SLUG = 'e2e-interview'
const E2E_EMAIL = 'delivered@resend.dev'
/** A run that dies before its own cleanup leaves no media behind for long. */
const E2E_PURGE_AFTER_MS = 24 * 60 * 60 * 1000

function requireFixturesEnabled() {
  if (process.env.E2E_FIXTURES !== 'enabled') {
    // Developer-facing, never shown to a user: a plain Error, not a code.
    throw new Error(
      '[interw] E2E fixtures are disabled on this deployment. ' +
        'Set E2E_FIXTURES=enabled on dev and staging only, never on production.',
    )
  }
}

/** A fresh two-question session; the org and role are created once. */
export const seedE2eSession = internalMutation({
  args: {},
  returns: v.object({ token: v.string() }),
  handler: async (ctx) => {
    requireFixturesEnabled()
    const now = Date.now()
    const org = await ctx.db
      .query('organizations')
      .withIndex('by_slug', (q) => q.eq('slug', E2E_ORG_SLUG))
      .unique()
    let project =
      org &&
      (await ctx.db
        .query('projects')
        .withIndex('by_org', (q) => q.eq('orgId', org._id))
        .first())
    if (!org) {
      const userId = await ctx.db.insert('users', {
        betterAuthId: `seed:${E2E_ORG_SLUG}`,
        email: E2E_EMAIL,
        superAdmin: false,
        createdAt: now,
      })
      const orgId = await ctx.db.insert('organizations', {
        slug: E2E_ORG_SLUG,
        name: 'E2E',
        createdBy: userId,
        createdAt: now,
      })
      await ctx.db.insert('organizationMembers', {
        orgId,
        userId,
        role: 'owner',
        joinedAt: now,
      })
      const projectId = await ctx.db.insert('projects', {
        orgId,
        slug: 'interview',
        title: 'E2E interview',
        status: 'active',
        language: 'en',
        introMode: 'none',
        candidateFields: {
          phone: { enabled: false, required: false },
          linkedin: { enabled: false, required: false },
          cv: { enabled: false, required: false },
          coverLetter: { enabled: false, required: false },
        },
        createdBy: userId,
        createdAt: now,
        sessionCount: 0,
        completedSessionCount: 0,
      })
      // The creator's seat, as `projects.create` writes it.
      await ctx.db.insert('projectShares', {
        orgId,
        projectId,
        userId,
        grantedBy: userId,
        grantedAt: now,
      })
      for (const [orderIndex, content] of [
        'Introduce yourself in one sentence.',
        'Name one thing you are proud of.',
      ].entries()) {
        await ctx.db.insert('questions', {
          orgId,
          projectId,
          orderIndex,
          content,
          maxResponseSeconds: 60,
        })
      }
      project = await ctx.db.get('projects', projectId)
    }
    if (!project) throw new ConvexError('not_found')

    const token = generateToken()
    await ctx.db.insert('sessions', {
      orgId: project.orgId,
      projectId: project._id,
      accessToken: token,
      candidateName: 'E2E Candidate',
      candidateEmail: E2E_EMAIL,
      status: 'pending',
      lastQuestionIndex: 0,
      invitedBy: project.createdBy,
      invitedAt: now,
      purgeAfter: now + E2E_PURGE_AFTER_MS,
    })
    await ctx.db.patch('projects', project._id, {
      sessionCount: project.sessionCount + 1,
    })
    return { token }
  },
})

/** What the browser test checks in the database once the candidate is done. */
export const e2eSessionState = internalQuery({
  args: { token: v.string() },
  returns: v.object({
    status: sessionStatusValidator,
    uploadedSegments: v.number(),
  }),
  handler: async (ctx, { token }) => {
    requireFixturesEnabled()
    const session = await ctx.db
      .query('sessions')
      .withIndex('by_token', (q) => q.eq('accessToken', token))
      .unique()
    if (!session) throw new ConvexError('not_found')
    const segments = await ctx.db
      .query('segments')
      .withIndex('by_session', (q) => q.eq('sessionId', session._id))
      .collect()
    return {
      status: session.status,
      uploadedSegments: segments.filter((s) => s.uploadState === 'uploaded')
        .length,
    }
  },
})
