/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { register as registerRateLimiter } from '@convex-dev/rate-limiter/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api, internal } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const sent = vi.hoisted(
  () => [] as Array<{ to: string; subject: string; html: string; text: string }>,
)

vi.mock('./email', () => ({
  RESEND_FROM: 'interw <no-reply@example.test>',
  resend: {
    sendEmail: (
      _ctx: unknown,
      email: { to: string; subject: string; html: string; text: string },
    ) => {
      sent.push(email)
      return Promise.resolve('provider-id-stub')
    },
  },
}))

// Who is calling; every decision after that is the product's own code.
vi.mock('./auth', () => ({
  authComponent: {
    safeGetAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      return identity ? { _id: identity.subject } : null
    },
    getAuthUser: async (ctx: {
      auth: { getUserIdentity: () => Promise<{ subject: string } | null> }
    }) => {
      const identity = await ctx.auth.getUserIdentity()
      if (!identity) throw new Error('Unauthenticated')
      return { _id: identity.subject }
    },
    registerRoutes: () => {},
  },
  createAuth: () => ({}),
}))

const modules = import.meta.glob('./**/*.ts')

/** The kind of label a recruiter gives a role for their own team. */
const INTERNAL_TITLE = 'Replace Paul (do not tell him) - budget 55k'
const CANDIDATE = 'alex@example.test'

function newTest() {
  const t = convexTest(schema, modules)
  registerRateLimiter(t, 'rateLimiter')
  return t
}

async function seed(
  t: ReturnType<typeof newTest>,
  jobTitle: string | undefined,
): Promise<Id<'projects'>> {
  return await t.run(async (ctx) => {
    const recruiter = await ctx.db.insert('users', {
      betterAuthId: 'ba_recruiter',
      email: 'r@acme.test',
      superAdmin: false,
      createdAt: 0,
    })
    const orgId = await ctx.db.insert('organizations', {
      slug: 'acme',
      name: 'Acme',
      createdBy: recruiter,
      createdAt: 0,
    })
    await ctx.db.insert('organizationMembers', {
      orgId,
      userId: recruiter,
      role: 'owner',
      joinedAt: 0,
    })
    return await ctx.db.insert('projects', {
      orgId,
      slug: 'replace-paul',
      title: INTERNAL_TITLE,
      jobTitle,
      status: 'active',
      language: 'en',
      introMode: 'none',
      maxDurationMinutes: 20,
      candidateFields: {
        phone: { enabled: false, required: false },
        linkedin: { enabled: false, required: false },
        cv: { enabled: false, required: false },
        coverLetter: { enabled: false, required: false },
      },
      createdBy: recruiter,
      createdAt: 0,
      sessionCount: 0,
      completedSessionCount: 0,
    })
  })
}

/** Every email a candidate can receive, for one role, in one language. */
async function everyCandidateEmail(
  t: ReturnType<typeof newTest>,
  projectId: Id<'projects'>,
  language: 'en' | 'fr',
) {
  await t.run((ctx) => ctx.db.patch('projects', projectId, { language }))
  const { results } = await t
    .withIdentity({ subject: 'ba_recruiter' })
    .mutation(api.sessions.invite, {
      projectId,
      candidates: [{ name: 'Alex Martin', email: CANDIDATE }],
    })
  const sessionId = results[0].sessionId
  // The invitation itself goes out from the scheduler.
  await t.finishAllScheduledFunctions(vi.runAllTimers)
  await t
    .withIdentity({ subject: 'ba_recruiter' })
    .mutation(api.sessions.resendInvitation, { sessionId })
  await t.mutation(internal.interview.sendCompletionEmail, { sessionId })
  const mail = sent.filter((email) => email.to === CANDIDATE)
  expect(mail).toHaveLength(3)
  return mail
}

// Fingerprint: convex/sessions.ts:sendInvitation:internal-title-fallback
// The invitation and the completion email fell back to the role's internal
// title when it had no public job title — a label written for the team,
// mailed to the person being assessed.
describe('what a candidate is told about the role, by email', () => {
  let t: ReturnType<typeof newTest>

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('SITE_URL', 'https://interw.test')
    sent.length = 0
    t = newTest()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  for (const language of ['en', 'fr'] as const) {
    it(`never carries the internal title (${language})`, async () => {
      const projectId = await seed(t, undefined)
      for (const email of await everyCandidateEmail(t, projectId, language)) {
        for (const part of [email.subject, email.html, email.text]) {
          expect(part).not.toContain(INTERNAL_TITLE)
          expect(part).not.toContain('Replace Paul')
          expect(part).not.toMatch(/undefined|null/)
        }
        expect(email.subject).toContain('Acme')
      }
    })

    it(`names the public job title when there is one (${language})`, async () => {
      const projectId = await seed(t, 'Backend Engineer')
      for (const email of await everyCandidateEmail(t, projectId, language)) {
        expect(email.text).toContain('Backend Engineer')
        for (const part of [email.subject, email.html, email.text]) {
          expect(part).not.toContain('Replace Paul')
        }
      }
    })
  }
})
