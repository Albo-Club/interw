/**
 * Runtime return contracts for the token-facing surfaces.
 *
 * The projectors in `candidateView.ts` are the right idea and are carefully
 * written — but nothing *imposed* them. A new candidate-facing function
 * returning a raw document, or one more field quietly added to an existing
 * response, would have passed review as easily as it passed the type checker,
 * and the first sign would have been a candidate reading a recruiter's private
 * note.
 *
 * These validators move that guarantee from the review to the runtime: Convex
 * checks the value on the way out and fails the call, so a leak introduced
 * later is found at deploy time by whoever introduced it. They are the cheapest
 * thing in this chantier relative to what they protect.
 *
 * They mirror `candidateView.ts` field for field. Adding a field there without
 * adding it here fails every test that calls the function — which is the point,
 * and is why the duplication is worth it.
 */

import { v } from 'convex/values'

import {
  candidateFieldsValidator,
  introModeValidator,
  languageValidator,
  mediaKindValidator,
  sessionStatusValidator,
} from '../schema'

/** Mirrors `toCandidateSessionView`. */
export const candidateSessionReturns = v.object({
  candidateName: v.string(),
  candidateEmail: v.string(),
  status: sessionStatusValidator,
  consentAcceptedAt: v.union(v.number(), v.null()),
  startedAt: v.union(v.number(), v.null()),
  completedAt: v.union(v.number(), v.null()),
  lastQuestionIndex: v.number(),
  hasCv: v.boolean(),
  hasCoverLetter: v.boolean(),
})

/** Mirrors `toCandidateProjectView`. */
export const candidateProjectReturns = v.object({
  jobTitle: v.union(v.string(), v.null()),
  language: languageValidator,
  personaName: v.union(v.string(), v.null()),
  introMode: introModeValidator,
  hasIntroMedia: v.boolean(),
  maxDurationMinutes: v.number(),
  candidateFields: candidateFieldsValidator,
  questionCount: v.number(),
})

/** Mirrors `toCandidateQuestionView`. No `mediaKey`: the candidate gets a
 *  signed URL minted after their token was checked, never the key. */
export const candidateQuestionReturns = v.object({
  questionId: v.id('questions'),
  orderIndex: v.number(),
  content: v.string(),
  hintText: v.union(v.string(), v.null()),
  maxResponseSeconds: v.number(),
  mediaKind: v.union(mediaKindValidator, v.null()),
  hasMedia: v.boolean(),
})

/** Mirrors `SessionGate` from `sessionState.ts`. */
export const sessionGateReturns = v.object({
  state: v.union(
    v.literal('ready'),
    v.literal('resumable'),
    v.literal('completed'),
    v.literal('cancelled'),
    v.literal('expired'),
    v.literal('closed'),
  ),
  canRecord: v.boolean(),
  needsConsent: v.boolean(),
  resumeAtIndex: v.number(),
})
