/**
 * What a candidate is allowed to see.
 *
 * Every field is listed explicitly and nothing is ever spread. The point is
 * that adding a column to `sessions` — a recruiter's private note, a decision,
 * a score — cannot leak by default: it has to be added here on purpose. The
 * previous build filtered in the browser and exposed every candidate's PII;
 * the equivalent mistake here would be `return session`.
 *
 * Never returned to a candidate, at any point:
 *   recruiterNote, recruiterDecision*, accessToken, orgId, invitedBy,
 *   purgeAfter, and anything from `reports`.
 */

import type { Doc } from '../_generated/dataModel'
import type { SessionGate } from './sessionState'

export type CandidateSessionView = {
  candidateName: string
  candidateEmail: string
  status: Doc<'sessions'>['status']
  consentAcceptedAt: number | null
  startedAt: number | null
  completedAt: number | null
  lastQuestionIndex: number
  hasCv: boolean
  hasCoverLetter: boolean
}

export function toCandidateSessionView(
  session: Doc<'sessions'>,
): CandidateSessionView {
  return {
    candidateName: session.candidateName,
    candidateEmail: session.candidateEmail,
    status: session.status,
    consentAcceptedAt: session.consentAcceptedAt ?? null,
    startedAt: session.startedAt ?? null,
    completedAt: session.completedAt ?? null,
    lastQuestionIndex: session.lastQuestionIndex,
    hasCv: session.cvKey !== undefined,
    hasCoverLetter: session.coverLetterKey !== undefined,
  }
}

export type CandidateProjectView = {
  jobTitle: string | null
  language: Doc<'projects'>['language']
  personaName: string | null
  introMode: 'none' | 'video'
  hasIntroMedia: boolean
  maxDurationMinutes: number
  candidateFields: Doc<'projects'>['candidateFields']
  questionCount: number
}

/**
 * A retired `text` or `audio` intro reads as none, for the recruiter and the
 * candidate alike: the candidate goes straight to the questions rather than
 * to an intro screen with nothing on it.
 */
export function effectiveIntroMode(
  project: Pick<Doc<'projects'>, 'introMode'>,
): 'none' | 'video' {
  return project.introMode === 'video' ? 'video' : 'none'
}

export function toCandidateProjectView(
  project: Doc<'projects'>,
  questionCount: number,
): CandidateProjectView {
  return {
    jobTitle: project.jobTitle ?? null,
    language: project.language,
    personaName: project.personaName ?? null,
    introMode: effectiveIntroMode(project),
    hasIntroMedia: project.introMediaKey !== undefined,
    maxDurationMinutes: project.maxDurationMinutes,
    candidateFields: project.candidateFields,
    questionCount,
  }
}

/**
 * A question as the candidate sees it while answering.
 *
 * `mediaKey` is deliberately absent: the key is an internal address, and the
 * candidate receives a signed URL minted after their token was checked.
 */
export type CandidateQuestionView = {
  questionId: Doc<'questions'>['_id']
  orderIndex: number
  content: string
  hintText: string | null
  maxResponseSeconds: number
  // `NonNullable`, not the column's own type: the projector always resolves
  // the absent case to `null`, and saying so is what lets the `returns`
  // validator in candidateReturns.ts state the same thing.
  mediaKind: NonNullable<Doc<'questions'>['mediaKind']> | null
  hasMedia: boolean
}

export function toCandidateQuestionView(
  question: Doc<'questions'>,
): CandidateQuestionView {
  return {
    questionId: question._id,
    orderIndex: question.orderIndex,
    content: question.content,
    hintText: question.hintText ?? null,
    maxResponseSeconds: question.maxResponseSeconds,
    mediaKind: question.mediaKind ?? null,
    hasMedia: question.mediaKey !== undefined,
  }
}

export type CandidateLandingView = {
  organisationName: string
  session: CandidateSessionView
  project: CandidateProjectView
  gate: SessionGate & { resumeAtIndex: number }
}
