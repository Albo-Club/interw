import { describe, expect, it } from 'vitest'

import { evaluateSessionGate } from './sessionState'
import type { ProjectLike, SessionLike } from './sessionState'

const NOW = 1_700_000_000_000

const session = (overrides: Partial<SessionLike> = {}): SessionLike => ({
  status: 'pending',
  lastQuestionIndex: 0,
  consentAcceptedAt: NOW - 1000,
  ...overrides,
})

const project = (overrides: Partial<ProjectLike> = {}): ProjectLike => ({
  status: 'active',
  ...overrides,
})

const gate = (s: SessionLike, p: ProjectLike) =>
  evaluateSessionGate({ session: s, project: p, now: NOW })

describe('evaluateSessionGate', () => {
  it('lets a consented, pending candidate record', () => {
    expect(gate(session(), project())).toMatchObject({
      state: 'ready',
      canRecord: true,
      needsConsent: false,
    })
  })

  it('asks for consent before recording', () => {
    expect(
      gate(session({ consentAcceptedAt: undefined }), project()),
    ).toMatchObject({ state: 'ready', canRecord: false, needsConsent: true })
  })

  it('resumes an interrupted interview at the question it stopped on', () => {
    expect(
      gate(session({ status: 'in_progress', lastQuestionIndex: 3 }), project()),
    ).toMatchObject({ state: 'resumable', canRecord: true, resumeAtIndex: 3 })
  })

  it('closes a link once the role expires', () => {
    expect(gate(session(), project({ expiresAt: NOW - 1 }))).toMatchObject({
      state: 'expired',
      canRecord: false,
    })
  })

  it('keeps a link open right up to the expiry instant', () => {
    expect(gate(session(), project({ expiresAt: NOW }))).toMatchObject({
      state: 'ready',
      canRecord: true,
    })
  })

  // A link sent while the role was live must stop working when it is archived.
  it('closes a link when the role is archived or still a draft', () => {
    expect(gate(session(), project({ status: 'archived' })).state).toBe('closed')
    expect(gate(session(), project({ status: 'draft' })).state).toBe('closed')
  })

  it('never lets a completed interview be recorded over', () => {
    expect(gate(session({ status: 'completed' }), project())).toMatchObject({
      state: 'completed',
      canRecord: false,
    })
  })

  it('reports a cancelled session as cancelled', () => {
    expect(gate(session({ status: 'cancelled' }), project()).state).toBe(
      'cancelled',
    )
  })

  // Otherwise a candidate who finished would be told the role is gone.
  it('prefers the terminal session state over the role state', () => {
    expect(
      gate(session({ status: 'completed' }), project({ status: 'archived' }))
        .state,
    ).toBe('completed')
    expect(
      gate(
        session({ status: 'completed' }),
        project({ expiresAt: NOW - 1000 }),
      ).state,
    ).toBe('completed')
  })

  it('never returns a negative resume index', () => {
    expect(
      gate(session({ lastQuestionIndex: -1 }), project()).resumeAtIndex,
    ).toBe(0)
  })
})
