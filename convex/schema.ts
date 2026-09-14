import { defineSchema, defineTable } from 'convex/server'
import { v } from 'convex/values'

export const roleValidator = v.union(
  v.literal('owner'),
  v.literal('admin'),
  v.literal('member'),
)

export const invitationRoleValidator = v.union(
  v.literal('admin'),
  v.literal('member'),
)


/* ─────────────────────────── Interw domain validators ───────────────────────
 * Exported so function args and return shapes reuse the schema's own unions
 * instead of re-declaring them (and drifting).
 * ------------------------------------------------------------------------- */

export const projectStatusValidator = v.union(
  v.literal('draft'),
  v.literal('active'),
  v.literal('archived'),
)

export const languageValidator = v.union(v.literal('fr'), v.literal('en'))

export const introModeValidator = v.union(
  v.literal('none'),
  v.literal('text'),
  v.literal('audio'),
  v.literal('video'),
)

export const mediaKindValidator = v.union(
  v.literal('audio'),
  v.literal('video'),
)

/** Which optional candidate fields the landing page asks for. */
export const candidateFieldsValidator = v.object({
  phone: v.object({ enabled: v.boolean(), required: v.boolean() }),
  linkedin: v.object({ enabled: v.boolean(), required: v.boolean() }),
  cv: v.object({ enabled: v.boolean(), required: v.boolean() }),
  coverLetter: v.object({ enabled: v.boolean(), required: v.boolean() }),
})

export const sessionStatusValidator = v.union(
  v.literal('pending'),
  v.literal('in_progress'),
  v.literal('completed'),
  v.literal('cancelled'),
  v.literal('expired'),
)

export const recruiterDecisionValidator = v.union(
  v.literal('rejected'),
  v.literal('maybe'),
  v.literal('shortlisted'),
  v.literal('hired'),
)

export const uploadStateValidator = v.union(
  v.literal('pending'),
  v.literal('uploaded'),
  v.literal('failed'),
)

export const recommendationValidator = v.union(
  v.literal('strong_no'),
  v.literal('no'),
  v.literal('maybe'),
  v.literal('yes'),
  v.literal('strong_yes'),
)

export const fitLevelValidator = v.union(
  v.literal('excellent'),
  v.literal('solid'),
  v.literal('partial'),
  v.literal('gap'),
)

export const depthLevelValidator = v.union(
  v.literal('surface'),
  v.literal('concrete'),
  v.literal('expert'),
)

/**
 * The six para-verbal dimensions — HOW an answer was delivered, as opposed to
 * what it said.
 *
 * All six are computed from the timestamped transcript, deterministically, by
 * convex/lib/paraverbal.ts. No model is asked to score them. The stack has no
 * audio-capable model, so a "vocal warmth" or "confidence" score would be an
 * invention dressed as a measurement — and this product must not invent
 * anything about a candidate. Speaking rate, hesitation, pausing and length
 * discipline are genuinely measurable from what we already hold, and they are
 * the substance of para-verbal analysis anyway.
 */
export const paraverbalDimensionValidator = v.union(
  v.literal('pace'),
  v.literal('fluency'),
  v.literal('pauses'),
  v.literal('concision'),
  v.literal('consistency'),
  v.literal('engagement'),
)

export const highlightKindValidator = v.union(
  v.literal('strength'),
  v.literal('personality'),
  v.literal('watchpoint'),
)

/** One pipeline step. Mirrors the chain in convex/pipeline.ts. */
export const jobStepValidator = v.union(
  v.literal('transcribe'),
  v.literal('report'),
  v.literal('notify'),
)

export const jobOutcomeValidator = v.union(
  v.literal('started'),
  v.literal('succeeded'),
  v.literal('failed'),
  v.literal('skipped'),
)

/** Candidate-side technical events. Kept coarse: this is a support trail and
 *  a health signal, not an analytics stream. */
export const sessionEventKindValidator = v.union(
  v.literal('device_check_passed'),
  v.literal('device_check_failed'),
  v.literal('consent_accepted'),
  v.literal('recording_started'),
  v.literal('upload_retried'),
  v.literal('upload_failed'),
  v.literal('network_degraded'),
  v.literal('interview_resumed'),
  v.literal('render_error'),
)

/** A quote anchored to the exact second of the video that backs it. Every
 *  claim the model makes carries one — that is what makes the report an
 *  evaluation rather than an opinion. */
const evidenceValidator = v.object({
  segmentId: v.id('segments'),
  startSeconds: v.number(),
  quote: v.string(),
})

export default defineSchema({
  users: defineTable({
    betterAuthId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
    avatarStorageId: v.optional(v.id('_storage')),
    superAdmin: v.boolean(),
    preferredLanguage: v.optional(v.union(v.literal('en'), v.literal('fr'))),
    createdAt: v.number(),
    // Deprecated: the per-user "last viewed org" now lives in `userPrefs`
    // (see below) to keep it off the hot `users` row. Kept here as an
    // optional legacy field so documents written before the move still
    // validate; never written anymore, only read as a fallback by
    // `getLastOrgSlug` until `userPrefs` is populated on next navigation.
    lastOrgSlug: v.optional(v.string()),
  })
    .index('by_betterAuthId', ['betterAuthId'])
    .index('by_email', ['email']),

  // Frequently-written per-user state, isolated from `users` on purpose:
  // every query reads the caller's `users` row (requireAppUser), so writes
  // there invalidate ALL open subscriptions. See KNOWN_ISSUES.md
  // § "Hot `users` row".
  userPrefs: defineTable({
    userId: v.id('users'),
    lastOrgSlug: v.optional(v.string()),
  }).index('by_user', ['userId']),

  organizations: defineTable({
    slug: v.string(),
    name: v.string(),
    logoUrl: v.optional(v.string()),
    logoStorageId: v.optional(v.id('_storage')),
    createdBy: v.id('users'),
    createdAt: v.number(),
  }).index('by_slug', ['slug']),

  organizationMembers: defineTable({
    orgId: v.id('organizations'),
    userId: v.id('users'),
    role: roleValidator,
    joinedAt: v.number(),
  })
    .index('by_org', ['orgId'])
    .index('by_user', ['userId'])
    .index('by_org_and_user', ['orgId', 'userId']),

  invitations: defineTable({
    orgId: v.id('organizations'),
    email: v.string(),
    role: invitationRoleValidator,
    token: v.string(),
    invitedBy: v.id('users'),
    expiresAt: v.number(),
    acceptedAt: v.optional(v.number()),
  })
    .index('by_token', ['token'])
    .index('by_org', ['orgId'])
    .index('by_email_and_org', ['email', 'orgId']),

  items: defineTable({
    orgId: v.id('organizations'),
    title: v.string(),
    description: v.optional(v.string()),
    createdBy: v.id('users'),
    createdAt: v.number(),
  }).index('by_org', ['orgId']),

  /* ───────────────────────────── Interw domain ──────────────────────────────
   * Every business table carries `orgId` and a `by_org` index: org scoping is
   * a property of the row, never of the query that happens to be written
   * correctly.
   *
   * No column anywhere holds a URL. Media is addressed by object key (`*Key`)
   * and signed at read time, after an access check. A URL written to the
   * database outlives the permission that produced it — that is exactly how
   * the previous Interw leaked candidate video.
   * ----------------------------------------------------------------------- */

  /** A role to fill: the interview template a candidate is invited to take. */
  projects: defineTable({
    orgId: v.id('organizations'),
    slug: v.string(),
    title: v.string(),
    jobTitle: v.optional(v.string()),
    status: projectStatusValidator,
    language: languageValidator,
    personaName: v.optional(v.string()),
    personaAvatarKey: v.optional(v.string()),
    introMode: introModeValidator,
    introText: v.optional(v.string()),
    introMediaKey: v.optional(v.string()),
    maxDurationMinutes: v.number(),
    candidateFields: candidateFieldsValidator,
    expiresAt: v.optional(v.number()),
    createdBy: v.id('users'),
    createdAt: v.number(),
    archivedAt: v.optional(v.number()),
    /** True once `projectShares` rows exist for this project. Denormalised so
     *  listing projects does not need one "is this restricted?" query per row. */
    restricted: v.boolean(),
    /** Denormalised counters, maintained in the same mutation as every session
     *  insert and status change. Convex has no count operator, and
     *  `.collect().length` over a project's sessions does not scale. */
    sessionCount: v.number(),
    completedSessionCount: v.number(),
  })
    .index('by_org', ['orgId'])
    .index('by_org_and_status', ['orgId', 'status'])
    // Slugs are unique per organisation, not globally: two customers may both
    // be hiring a "senior-backend-engineer".
    .index('by_org_and_slug', ['orgId', 'slug']),

  questions: defineTable({
    orgId: v.id('organizations'),
    projectId: v.id('projects'),
    orderIndex: v.number(),
    title: v.optional(v.string()),
    content: v.string(),
    /** Recruiter-recorded prompt. The AI never speaks: it evaluates. */
    mediaKey: v.optional(v.string()),
    mediaKind: v.optional(mediaKindValidator),
    hintText: v.optional(v.string()),
    maxResponseSeconds: v.number(),
    /** Per-question override of criteria weighting, criterion id → weight. */
    criteriaWeights: v.optional(v.record(v.id('criteria'), v.number())),
  })
    .index('by_project', ['projectId', 'orderIndex'])
    .index('by_org', ['orgId']),

  criteria: defineTable({
    orgId: v.id('organizations'),
    projectId: v.id('projects'),
    label: v.string(),
    description: v.optional(v.string()),
    /** Raw 0..100 weight as typed by the recruiter; normalised at read time
     *  (see convex/lib/weights.ts) so the stored value never silently shifts
     *  under the user while they are editing a set. */
    weight: v.number(),
    orderIndex: v.number(),
  })
    .index('by_project', ['projectId', 'orderIndex'])
    .index('by_org', ['orgId']),

  /** One candidate on one project. Only a recruiter creates these: with no
   *  public project page in scope, no anonymous caller ever writes here
   *  without a pre-existing token. */
  sessions: defineTable({
    orgId: v.id('organizations'),
    projectId: v.id('projects'),
    /** 32 bytes of CSPRNG, base64url. Never returned in a recruiter-facing
     *  list — only ever rendered into the invitation link, server-side. */
    accessToken: v.string(),
    candidateName: v.string(),
    candidateEmail: v.string(),
    candidatePhone: v.optional(v.string()),
    candidateLinkedin: v.optional(v.string()),
    cvKey: v.optional(v.string()),
    coverLetterKey: v.optional(v.string()),
    status: sessionStatusValidator,
    consentAcceptedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastActivityAt: v.optional(v.number()),
    lastQuestionIndex: v.number(),
    durationSeconds: v.optional(v.number()),
    recruiterDecision: v.optional(recruiterDecisionValidator),
    recruiterDecisionBy: v.optional(v.id('users')),
    recruiterDecisionAt: v.optional(v.number()),
    recruiterNote: v.optional(v.string()),
    invitedBy: v.id('users'),
    invitedAt: v.number(),
    /** Retention clock. Set when the interview completes; the purge cron
     *  deletes media past it and logs the deletion. */
    purgeAfter: v.optional(v.number()),
    mediaPurgedAt: v.optional(v.number()),
  })
    .index('by_token', ['accessToken'])
    .index('by_project', ['projectId'])
    .index('by_org_and_status', ['orgId', 'status'])
    .index('by_org', ['orgId'])
    .index('by_purge_after', ['purgeAfter']),

  /** One row per answered question. A first-class table, not an entry in a
   *  message array: conflating turn-taking with media is what made resume and
   *  retry so fragile in the previous build. */
  segments: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    questionId: v.id('questions'),
    questionIndex: v.number(),
    videoKey: v.optional(v.string()),
    audioKey: v.optional(v.string()),
    thumbnailKey: v.optional(v.string()),
    durationSeconds: v.optional(v.number()),
    uploadState: uploadStateValidator,
    uploadAttempts: v.number(),
    recordedAt: v.number(),
  })
    .index('by_session', ['sessionId', 'questionIndex'])
    .index('by_org', ['orgId']),

  transcripts: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    segmentId: v.id('segments'),
    text: v.string(),
    /** Timed chunks as returned by the transcription model (sentence-level,
     *  not literally one entry per word). Named `words` to match the agreed
     *  data model. */
    words: v.array(
      v.object({ start: v.number(), end: v.number(), text: v.string() }),
    ),
    model: v.string(),
    createdAt: v.number(),
  })
    .index('by_session', ['sessionId'])
    .index('by_segment', ['segmentId'])
    .index('by_org', ['orgId']),

  reports: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    overallScore: v.number(),
    recommendation: recommendationValidator,
    executiveSummary: v.string(),
    criteriaScores: v.array(
      v.object({
        criterionId: v.id('criteria'),
        score: v.number(),
        rationale: v.string(),
        evidence: v.array(evidenceValidator),
      }),
    ),
    strengths: v.array(v.string()),
    concerns: v.array(v.string()),
    /** Criterion × question grid. Typed rather than `v.any()`: an untyped
     *  blob here is how a model's malformed output reaches the UI. */
    fitMatrix: v.optional(
      v.object({
        criteria: v.array(
          v.object({
            criterionId: v.id('criteria'),
            score: v.number(),
            level: fitLevelValidator,
            statement: v.string(),
          }),
        ),
        questions: v.array(
          v.object({
            questionId: v.id('questions'),
            questionIndex: v.number(),
            score: v.number(),
            summary: v.string(),
            depth: depthLevelValidator,
            evidence: v.optional(evidenceValidator),
          }),
        ),
      }),
    ),
    /** Computed, not generated — see paraverbalDimensionValidator. */
    paraverbal: v.optional(
      v.object({
        dimensions: v.array(
          v.object({
            key: paraverbalDimensionValidator,
            /** 0..10. */
            score: v.number(),
            /** The measurement behind the score, e.g. words per minute. */
            measure: v.number(),
          }),
        ),
        wordsPerMinute: v.number(),
        totalSpeakingSeconds: v.number(),
      }),
    ),
    highlights: v.optional(
      v.array(
        v.object({
          segmentId: v.id('segments'),
          startSeconds: v.number(),
          endSeconds: v.number(),
          kind: highlightKindValidator,
          label: v.string(),
        }),
      ),
    ),
    model: v.string(),
    generatedAt: v.number(),
  })
    .index('by_session', ['sessionId'])
    .index('by_org', ['orgId']),

  reportShares: defineTable({
    orgId: v.id('organizations'),
    reportId: v.id('reports'),
    token: v.string(),
    createdBy: v.id('users'),
    expiresAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    lastViewedAt: v.optional(v.number()),
    viewCount: v.number(),
    createdAt: v.number(),
  })
    .index('by_token', ['token'])
    .index('by_report', ['reportId'])
    .index('by_org', ['orgId']),

  /** Restricts a project to named colleagues. Absence of any row means the
   *  project is visible to the whole organisation. */
  projectShares: defineTable({
    orgId: v.id('organizations'),
    projectId: v.id('projects'),
    userId: v.id('users'),
    grantedBy: v.id('users'),
    grantedAt: v.number(),
  })
    .index('by_project', ['projectId'])
    .index('by_user', ['userId'])
    .index('by_project_and_user', ['projectId', 'userId']),

  emailLog: defineTable({
    orgId: v.optional(v.id('organizations')),
    template: v.string(),
    recipient: v.string(),
    status: v.union(
      v.literal('sent'),
      v.literal('delivered'),
      v.literal('bounced'),
      v.literal('complained'),
      v.literal('failed'),
    ),
    providerId: v.optional(v.string()),
    error: v.optional(v.string()),
    sessionId: v.optional(v.id('sessions')),
    createdAt: v.number(),
  })
    .index('by_org_and_created', ['orgId', 'createdAt'])
    .index('by_recipient', ['recipient'])
    .index('by_provider_id', ['providerId']),

  /** Proof of erasure. Deliberately holds a HASH of the candidate's address,
   *  not the address: a deletion register must be able to answer "did you
   *  erase the data for this person?" — which a hash does, by hashing the
   *  address they ask with — without keeping the personal data the register
   *  exists to record the destruction of. */
  purgeLog: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    candidateEmailHash: v.string(),
    reason: v.union(
      v.literal('retention'),
      v.literal('candidate_request'),
      v.literal('recruiter_delete'),
    ),
    objectsDeleted: v.number(),
    purgedAt: v.number(),
  })
    .index('by_org_and_purged', ['orgId', 'purgedAt'])
    .index('by_session', ['sessionId']),

  /** Every pipeline state transition, with its duration and outcome. This is
   *  what makes "a step can fail" observable instead of a lost session — and
   *  it is why there are no catch-up scripts. */
  jobLog: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    step: jobStepValidator,
    outcome: jobOutcomeValidator,
    attempt: v.number(),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
    at: v.number(),
  })
    .index('by_session', ['sessionId'])
    .index('by_step_and_outcome', ['step', 'outcome', 'at'])
    .index('by_org_and_at', ['orgId', 'at']),

  /** Candidate-side technical trail: why a device check failed, when an
   *  upload was retried, when the network dropped. Purged with the session. */
  sessionEvents: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    kind: sessionEventKindValidator,
    detail: v.optional(v.string()),
    at: v.number(),
  }).index('by_session', ['sessionId', 'at']),
})
