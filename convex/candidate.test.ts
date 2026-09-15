/// <reference types="vite/client" />
import { convexTest } from 'convex-test'
import { beforeEach, describe, expect, it } from 'vitest'

import { api } from './_generated/api'
import schema from './schema'
import type { Id } from './_generated/dataModel'

const modules = import.meta.glob('./**/*.ts')
const NOW = 1_800_000_000_000

function newTest() {
  return convexTest(schema, modules)
}

type Seed = {
  acmeToken: string
  globexToken: string
  acmeSessionId: Id<'sessions'>
}

/**
 * Two organisations, each with a role and one invited candidate. The point of
 * the second one is to make "does a token reach across organisations?" a
 * question the test suite answers rather than one the reviewer has to.
 */
async function seed(t: ReturnType<typeof newTest>): Promise<Seed> {
  return await t.run(async (ctx) => {
    const userId = await ctx.db.insert('users', {
      betterAuthId: 'ba_recruiter',
      email: 'recruiter@acme.test',
      superAdmin: false,
      createdAt: 0,
    })

    const makeOrg = async (slug: string, name: string) =>
      await ctx.db.insert('organizations', {
        slug,
        name,
        createdBy: userId,
        createdAt: 0,
      })

    const makeProject = async (orgId: Id<'organizations'>, title: string) =>
      await ctx.db.insert('projects', {
        orgId,
        slug: title.toLowerCase(),
        title: `INTERNAL ${title}`,
        jobTitle: `${title} Engineer`,
        status: 'active',
        language: 'fr',
        introMode: 'none',
        maxDurationMinutes: 20,
        candidateFields: {
          phone: { enabled: true, required: false },
          linkedin: { enabled: false, required: false },
          cv: { enabled: true, required: false },
          coverLetter: { enabled: false, required: false },
        },
        createdBy: userId,
        createdAt: 0,
        restricted: false,
        sessionCount: 1,
        completedSessionCount: 0,
      })

    const makeSession = async (
      orgId: Id<'organizations'>,
      projectId: Id<'projects'>,
      token: string,
      email: string,
    ) =>
      await ctx.db.insert('sessions', {
        orgId,
        projectId,
        accessToken: token,
        candidateName: 'Alex Martin',
        candidateEmail: email,
        status: 'pending',
        lastQuestionIndex: 0,
        invitedBy: userId,
        invitedAt: 0,
        recruiterNote: 'CONFIDENTIAL recruiter note',
        recruiterDecision: 'maybe',
      })

    const acmeOrg = await makeOrg('acme', 'Acme')
    const globexOrg = await makeOrg('globex', 'Globex')
    const acmeProject = await makeProject(acmeOrg, 'Backend')
    const globexProject = await makeProject(globexOrg, 'Frontend')

    await ctx.db.insert('questions', {
      orgId: acmeOrg,
      projectId: acmeProject,
      orderIndex: 0,
      content: 'Tell me about a migration you led.',
      maxResponseSeconds: 120,
    })

    const acmeToken = 'a'.repeat(43)
    const globexToken = 'b'.repeat(43)
    const acmeSessionId = await makeSession(
      acmeOrg,
      acmeProject,
      acmeToken,
      'alex@acme-candidate.test',
    )
    await makeSession(
      globexOrg,
      globexProject,
      globexToken,
      'sam@globex-candidate.test',
    )

    return { acmeToken, globexToken, acmeSessionId }
  })
}

describe('candidate.landing', () => {
  let t: ReturnType<typeof newTest>
  let s: Seed

  beforeEach(async () => {
    t = newTest()
    s = await seed(t)
  })

  it('resolves a valid token to that candidate and no one else', async () => {
    const view = await t.query(api.candidate.landing, {
      token: s.acmeToken,
      now: NOW,
    })
    expect(view.organisationName).toBe('Acme')
    expect(view.session.candidateEmail).toBe('alex@acme-candidate.test')
    expect(view.project.jobTitle).toBe('Backend Engineer')
    expect(view.project.questionCount).toBe(1)
    expect(view.gate.state).toBe('ready')
  })

  it('never returns the recruiter note or decision', async () => {
    const view = await t.query(api.candidate.landing, {
      token: s.acmeToken,
      now: NOW,
    })
    const serialised = JSON.stringify(view)
    expect(serialised).not.toContain('CONFIDENTIAL')
    expect(serialised).not.toContain('recruiterDecision')
  })

  it('never returns the access token or the internal role title', async () => {
    const view = await t.query(api.candidate.landing, {
      token: s.acmeToken,
      now: NOW,
    })
    const serialised = JSON.stringify(view)
    expect(serialised).not.toContain(s.acmeToken)
    expect(serialised).not.toContain('INTERNAL')
  })

  it("one organisation's token never resolves to another's data", async () => {
    const view = await t.query(api.candidate.landing, {
      token: s.globexToken,
      now: NOW,
    })
    expect(view.organisationName).toBe('Globex')
    expect(view.session.candidateEmail).toBe('sam@globex-candidate.test')
  })

  // Unknown, malformed and traversal-shaped tokens must be indistinguishable.
  it('fails identically for every token that does not resolve', async () => {
    const failures: Array<string> = []
    for (const token of [
      'c'.repeat(43),
      '',
      'short',
      '../../sessions',
      'a'.repeat(43) + 'x',
    ]) {
      await t
        .query(api.candidate.landing, { token, now: NOW })
        .then(
          () => failures.push(`resolved: ${token}`),
          (error: Error) => failures.push(error.message),
        )
    }
    expect(new Set(failures).size).toBe(1)
    expect(failures[0]).toContain('not_found')
  })

  it('closes the link once the role expires', async () => {
    await t.run(async (ctx) => {
      const session = (await ctx.db.get('sessions', s.acmeSessionId))!
      await ctx.db.patch('projects', session.projectId, {
        expiresAt: NOW - 1,
      })
    })
    const view = await t.query(api.candidate.landing, {
      token: s.acmeToken,
      now: NOW,
    })
    expect(view.gate.state).toBe('expired')
    expect(view.gate.canRecord).toBe(false)
  })

  it('closes the link once the role is archived', async () => {
    await t.run(async (ctx) => {
      const session = (await ctx.db.get('sessions', s.acmeSessionId))!
      await ctx.db.patch('projects', session.projectId, { status: 'archived' })
    })
    const view = await t.query(api.candidate.landing, {
      token: s.acmeToken,
      now: NOW,
    })
    expect(view.gate.state).toBe('closed')
  })
})
