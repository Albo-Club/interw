import { describe, expect, it } from 'vitest'

import {
  toCandidateProjectView,
  toCandidateQuestionView,
  toCandidateSessionView,
} from './candidateView'
import type { DataModel, Doc, Id  } from '../_generated/dataModel'

const id = <T extends keyof DataModel>(table: T) =>
  `fake_${table}` as Id<T>

const session: Doc<'sessions'> = {
  _id: id('sessions'),
  _creationTime: 0,
  orgId: id('organizations'),
  projectId: id('projects'),
  accessToken: 'super-secret-token',
  candidateName: 'Alex Martin',
  candidateEmail: 'alex@example.test',
  candidatePhone: '+33600000000',
  status: 'in_progress',
  consentAcceptedAt: 10,
  startedAt: 20,
  lastQuestionIndex: 2,
  invitedBy: id('users'),
  invitedAt: 0,
  cvKey: 'orgs/o/sessions/s/cv.pdf',
  recruiterNote: 'Weak on the architecture question, but coachable.',
  recruiterDecision: 'maybe',
  recruiterDecisionBy: id('users'),
  recruiterDecisionAt: 30,
  purgeAfter: 999,
}

const project: Doc<'projects'> = {
  _id: id('projects'),
  _creationTime: 0,
  orgId: id('organizations'),
  slug: 'backend',
  title: 'Internal title nobody outside should read',
  jobTitle: 'Senior Backend Engineer',
  status: 'active',
  language: 'fr',
  introMode: 'text',
  introText: 'Bienvenue',
  introMediaKey: 'orgs/o/projects/p/intro.webm',
  maxDurationMinutes: 25,
  candidateFields: {
    phone: { enabled: true, required: false },
    linkedin: { enabled: false, required: false },
    cv: { enabled: true, required: true },
    coverLetter: { enabled: false, required: false },
  },
  createdBy: id('users'),
  createdAt: 0,
  restricted: true,
  sessionCount: 12,
  completedSessionCount: 5,
}

const fourQuestions = [120, 120, 120, 120].map((maxResponseSeconds) => ({
  maxResponseSeconds,
}))

const question: Doc<'questions'> = {
  _id: id('questions'),
  _creationTime: 0,
  orgId: id('organizations'),
  projectId: id('projects'),
  orderIndex: 1,
  content: 'Tell me about a migration you led.',
  maxResponseSeconds: 120,
  mediaKey: 'orgs/o/projects/p/q-abc.webm',
  mediaKind: 'video',
}

/**
 * These are the tests that matter most in the whole suite. The previous build
 * leaked every candidate's PII because filtering happened in the browser.
 */
describe('candidate projections', () => {
  it('never exposes the access token or the owning organisation', () => {
    const view = toCandidateSessionView(session)
    expect(Object.keys(view)).not.toContain('accessToken')
    expect(Object.keys(view)).not.toContain('orgId')
    expect(JSON.stringify(view)).not.toContain('super-secret-token')
  })

  it('never exposes the recruiter note or decision', () => {
    const serialised = JSON.stringify(toCandidateSessionView(session))
    expect(serialised).not.toContain('coachable')
    expect(serialised).not.toContain('maybe')
    for (const field of [
      'recruiterNote',
      'recruiterDecision',
      'recruiterDecisionBy',
      'recruiterDecisionAt',
      'purgeAfter',
      'invitedBy',
    ]) {
      expect(Object.keys(toCandidateSessionView(session))).not.toContain(field)
    }
  })

  it('reports documents as booleans, never as object keys', () => {
    const view = toCandidateSessionView(session)
    expect(view.hasCv).toBe(true)
    expect(view.hasCoverLetter).toBe(false)
    expect(JSON.stringify(view)).not.toContain('cv.pdf')
  })

  it('shows the public job title, not the internal one', () => {
    const view = toCandidateProjectView(project, fourQuestions)
    expect(view.jobTitle).toBe('Senior Backend Engineer')
    expect(JSON.stringify(view)).not.toContain('Internal title')
  })

  // The legacy role-level duration (25 here) once told a candidate less time
  // than the questions took. What they are told now comes from the questions.
  it('announces the time the questions take, not the legacy field', () => {
    const view = toCandidateProjectView(project, fourQuestions)
    expect(view.maxInterviewMinutes).toBe(10)
    expect(view.questionCount).toBe(4)
    expect(Object.keys(view)).not.toContain('maxDurationMinutes')
  })

  it('never leaks pipeline counters or visibility settings to a candidate', () => {
    const keys = Object.keys(toCandidateProjectView(project, fourQuestions))
    for (const field of [
      'sessionCount',
      'completedSessionCount',
      'restricted',
      'createdBy',
      'orgId',
      'title',
      'introMediaKey',
    ]) {
      expect(keys).not.toContain(field)
    }
  })

  // Decision n° 1 (T05): an intro is the recruiter's video or nothing. A row
  // still holding a retired mode must not show the candidate an empty
  // player, nor hand them the retired text.
  it('reads a retired text or audio intro as no intro', () => {
    const recorded = { ...project, introMediaKey: 'orgs/o/projects/p/intro.webm' }
    for (const introMode of ['text', 'audio'] as const) {
      const view = toCandidateProjectView({ ...recorded, introMode }, fourQuestions)
      expect(view.hasIntro).toBe(false)
      expect(JSON.stringify(view)).not.toContain('Bienvenue')
    }
    expect(
      toCandidateProjectView({ ...recorded, introMode: 'video' }, fourQuestions).hasIntro,
    ).toBe(true)
  })

  // A key is an internal address; the candidate gets a signed URL instead,
  // minted only after their token has been checked.
  it('never hands a candidate a raw object key', () => {
    const view = toCandidateQuestionView(question)
    expect(view.hasMedia).toBe(true)
    expect(JSON.stringify(view)).not.toContain('q-abc.webm')
  })

  it('carries what the candidate actually needs', () => {
    expect(toCandidateQuestionView(question)).toMatchObject({
      content: 'Tell me about a migration you led.',
      maxResponseSeconds: 120,
      mediaKind: 'video',
      orderIndex: 1,
    })
  })
})
