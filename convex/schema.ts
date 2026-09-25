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

/** What a role opens on: nothing, or a video the recruiter filmed. */
export const introModeValidator = v.union(v.literal('none'), v.literal('video'))

/** What a stored row may still hold. `text` and `audio` are retired: read as
 *  `none` everywhere, rewritten by `media.migrateLegacyIntroModes`, and
 *  dropped from here once that has run on every deployment. */
const storedIntroModeValidator = v.union(
  introModeValidator,
  v.literal('text'),
  v.literal('audio'),
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

/** Where one answer got to in the transcription step. Both `done` and
 *  `failed` are terminal: the fan-in counts them the same way, and only the
 *  report cares about the difference. */
export const transcriptionStateValidator = v.union(
  v.literal('pending'),
  v.literal('done'),
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

export const highlightKindValidator = v.union(
  v.literal('strength'),
  v.literal('personality'),
  v.literal('watchpoint'),
)

/** One pipeline step. Mirrors the chain in convex/pipeline.ts.
 *  `relaunch` is not a step but an operator's decision to re-run one, kept in
 *  the same log so the reason a session moved again is where the rest of its
 *  history is. `purge` is the retention job (convex/retention.ts), logged
 *  when it fails for one session so that failure is not silent. */
export const jobStepValidator = v.union(
  v.literal('transcribe'),
  v.literal('report'),
  v.literal('notify'),
  v.literal('relaunch'),
  v.literal('purge'),
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
  v.literal('recording_recovered'),
  v.literal('render_error'),
  /** The candidate left the page with an answer recorded but not sent. */
  v.literal('recording_abandoned'),
)

/**
 * A quote from an answer, and the second of video it came from when the
 * transcript could be made to agree.
 *
 * `startSeconds` is absent exactly when `anchored` is false, and the pair is
 * written in one place (`lib/reportBuilder.ts`). Anchoring can fail honestly —
 * a model paraphrases a hesitant answer, or the provider returned no timed
 * segments for the clip at all — and the report then shows the quote without
 * offering to seek to it. The alternative, the model's own estimate, reads
 * like an answer and is not one: it sends the recruiter to the wrong moment,
 * and takes the credit of every other citation with it.
 */
const evidenceValidator = v.object({
  segmentId: v.id('segments'),
  startSeconds: v.optional(v.number()),
  anchored: v.boolean(),
  quote: v.string(),
})

/**
 * Criterion × question grid. Typed rather than `v.any()`: an untyped blob here
 * is how a model's malformed output reaches the UI.
 *
 * Declared here rather than inline in the table so the share surface's
 * `returns` validator can reuse it — the fields a share link shows ARE the
 * fields the table stores, and a second copy would drift from this one.
 */
export const fitMatrixValidator = v.object({
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
})

/** One scored criterion, with the quotes behind the score. */
export const criteriaScoresValidator = v.array(
  v.object({
    criterionId: v.id('criteria'),
    score: v.number(),
    rationale: v.string(),
    evidence: v.array(evidenceValidator),
  }),
)

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
    .index('by_email', ['email'])
    .index('by_avatarStorageId', ['avatarStorageId'])
    // "Is anyone else a super-admin?" without reading every user (Back F8).
    .index('by_superAdmin', ['superAdmin']),

  // Frequently-written per-user state, isolated from `users` on purpose:
  // every query reads the caller's `users` row (requireAppUser), so writes
  // there invalidate ALL open subscriptions. See KNOWN_ISSUES.md
  // § "Hot `users` row".
  userPrefs: defineTable({
    userId: v.id('users'),
    lastOrgSlug: v.optional(v.string()),
    // Where the last email change stands. Better Auth keeps nothing
    // queryable between its steps: `approve` (link mailed to the current
    // address), `verify` (link mailed to the new one), `done`. `at` is when
    // the step began — its link expires an hour later.
    emailChange: v.optional(
      v.object({
        newEmail: v.string(),
        step: v.union(
          v.literal('approve'),
          v.literal('verify'),
          v.literal('done'),
        ),
        at: v.number(),
      }),
    ),
  }).index('by_user', ['userId']),

  organizations: defineTable({
    slug: v.string(),
    name: v.string(),
    logoUrl: v.optional(v.string()),
    logoStorageId: v.optional(v.id('_storage')),
    createdBy: v.id('users'),
    createdAt: v.number(),
    /** Set when an owner asks for the organisation to be deleted. From then
     *  on it is frozen — no member, candidate or share link gets in — while
     *  convex/orgErasure.ts erases it and finally deletes this row. */
    deletingAt: v.optional(v.number()),
  })
    .index('by_slug', ['slug'])
    .index('by_logoStorageId', ['logoStorageId']),

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
    introMode: storedIntroModeValidator,
    /** Retired with the `text` intro mode: written and read by nothing. */
    introText: v.optional(v.string()),
    introMediaKey: v.optional(v.string()),
    /** Intro keys an upload slot was signed for and no attach has claimed
     *  yet, named before the PUT so deletion can find them. At most one per
     *  accepted type. See `reserveIntroUpload`. */
    pendingMediaKeys: v.optional(v.array(v.string())),
    maxDurationMinutes: v.number(),
    candidateFields: candidateFieldsValidator,
    expiresAt: v.optional(v.number()),
    createdBy: v.id('users'),
    createdAt: v.number(),
    archivedAt: v.optional(v.number()),
    /** Legacy, read by nothing. Every role is now visible to its team only
     *  (see `projectShares`), so the open/restricted switch is gone; the field
     *  stays optional only because existing rows still carry it. */
    restricted: v.optional(v.boolean()),
    /** Denormalised counters, maintained in the same mutation as every session
     *  insert and status change. Convex has no count operator, and
     *  `.collect().length` over a project's sessions does not scale. */
    sessionCount: v.number(),
    completedSessionCount: v.number(),
  })
    .index('by_org', ['orgId'])
    .index('by_org_and_status', ['orgId', 'status'])
    // Read by the expiry cron (B6): the roles whose deadline has passed.
    .index('by_expires_at', ['expiresAt'])
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
    /** Prompt keys signed and not yet attached; see `reserveQuestionUpload`. */
    pendingMediaKeys: v.optional(v.array(v.string())),
    hintText: v.optional(v.string()),
    maxResponseSeconds: v.number(),
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
    /** Document keys an upload slot was signed for and no attach has claimed
     *  yet, written before the PUT is signed so erasure can name them. At
     *  most one per kind and accepted type. See `reserveDocumentUpload`. */
    pendingDocumentKeys: v.optional(v.array(v.string())),
    status: sessionStatusValidator,
    consentAcceptedAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    lastActivityAt: v.optional(v.number()),
    lastQuestionIndex: v.number(),
    durationSeconds: v.optional(v.number()),
    /* ── Fan-in state, written only by convex/pipeline.ts ──────────────────
     * How many answers the pipeline is waiting on, and how many have reached
     * a TERMINAL outcome — succeeded or failed for good. Materialising the
     * count is what lets a definitive failure be an outcome rather than a
     * silence: the old gate asked "does every answer have a transcript?",
     * which a transcription that had exhausted its retries could never make
     * true again, so the session froze with no report and no alert.
     *
     * `reportJobEnqueuedAt` is the claim. The mutation that completes the
     * count reads and writes this row, so Convex's OCC picks exactly one of
     * two answers landing together — which is what stopped two `generateReport`
     * jobs, and two deep-model bills, per interview.
     * ------------------------------------------------------------------- */
    segmentsExpected: v.optional(v.number()),
    segmentsSettled: v.optional(v.number()),
    reportJobEnqueuedAt: v.optional(v.number()),
    /** The report's headline result, copied here once by the queue when the
     *  report is written. Denormalised because the two screens that need it —
     *  the dashboard and the candidate table — need it for every row at once,
     *  and reading `reports` per session made the dashboard a reactive N+1
     *  that re-ran on every candidate's upload. Never written by a recruiter;
     *  the report remains the source of truth. */
    overallScore: v.optional(v.number()),
    recommendation: v.optional(recommendationValidator),
    recruiterDecision: v.optional(recruiterDecisionValidator),
    recruiterDecisionBy: v.optional(v.id('users')),
    recruiterDecisionAt: v.optional(v.number()),
    recruiterNote: v.optional(v.string()),
    invitedBy: v.id('users'),
    invitedAt: v.number(),
    /** Retention clock. Set at invitation with a short window and pushed out
     *  when the interview completes; the purge cron deletes media past it and
     *  logs the deletion. */
    purgeAfter: v.optional(v.number()),
    mediaPurgedAt: v.optional(v.number()),
  })
    .index('by_token', ['accessToken'])
    .index('by_project', ['projectId'])
    // The expiry cron (B6) reads a role's still-open sessions, not all of them.
    .index('by_project_and_status', ['projectId', 'status'])
    .index('by_project_and_email', ['projectId', 'candidateEmail'])
    // Deployment-wide, for the super-admin health screen: "which interviews
    // finished and never produced a report?" is not a per-organisation
    // question.
    .index('by_status_and_completed', ['status', 'completedAt'])
    .index('by_org_and_status', ['orgId', 'status'])
    .index('by_org', ['orgId'])
    // The dashboard's "invited in the last 30 days" (Back M3), read as a range
    // that stops at the window's edge.
    .index('by_org_and_invited', ['orgId', 'invitedAt'])
    // `mediaPurgedAt` leads so the range can exclude sessions already purged
    // without a JS filter. Filtering them afterwards would let them pile up in
    // the range and saturate the batch all over again — the shape of the bug
    // this index was changed to fix.
    .index('by_media_purged_and_purge_after', ['mediaPurgedAt', 'purgeAfter'])
    // Global candidate search. Scoped by orgId in the filter field so a query
    // can never reach past the caller's organisation, index or not.
    .searchIndex('search_candidate', {
      searchField: 'candidateName',
      filterFields: ['orgId'],
    }),

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
    /** False from reservation until the video PUT is confirmed. The key is
     *  written first so erasure can name it, which means a key alone does not
     *  say an object sits behind it. Absent on rows older than the field,
     *  whose videos are taken as present. */
    videoUploaded: v.optional(v.boolean()),
    /** Keys this slot was reserved under before and no longer is. Re-reserving
     *  an answer in another container, or without video, changes its keys,
     *  and the earlier object would otherwise be named nowhere — out of reach
     *  of every erasure path. */
    supersededKeys: v.optional(v.array(v.string())),
    /** Reported by the candidate's browser: a display hint, never an input
     *  to the report. */
    durationSeconds: v.optional(v.number()),
    /** The answer's length as the server observed it at transcription. What
     *  the duration the recruiter is served and the quote anchors come from. */
    measuredSeconds: v.optional(v.number()),
    uploadState: uploadStateValidator,
    uploadAttempts: v.number(),
    /** Where this answer got to in the pipeline. `failed` is a terminal state,
     *  not a missing transcript: it is what lets the fan-in complete and the
     *  report say which answers it could not read. */
    transcriptionState: v.optional(transcriptionStateValidator),
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
    criteriaScores: criteriaScoresValidator,
    strengths: v.array(v.string()),
    concerns: v.array(v.string()),
    /** True when at least one answer could not be transcribed and the report
     *  was written without it. A report that is missing evidence has to say
     *  so: the alternative is a confident-looking assessment of five answers
     *  presented as an assessment of seven. */
    partial: v.optional(v.boolean()),
    /** Criterion × question grid. Typed rather than `v.any()`: an untyped
     *  blob here is how a model's malformed output reaches the UI. */
    fitMatrix: v.optional(fitMatrixValidator),
    /** Retired: the para-verbal figures are no longer computed, written or
     *  read (see KNOWN_ISSUES.md § "Para-verbal analysis was removed"). Kept
     *  optional only so reports written before the removal still validate;
     *  the field can go once a migration has cleared it. */
    paraverbal: v.optional(
      v.object({
        dimensions: v.array(
          v.object({ key: v.string(), score: v.number(), measure: v.number() }),
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
    .index('by_org', ['orgId'])
    // A share link acts for whoever created it: when that person leaves the
    // org or deletes their account, their links are revoked with them.
    .index('by_creator_and_org', ['createdBy', 'orgId']),

  /** A role's team: the colleagues who follow it. One row per member, on top
   *  of the creator, who is always on the team and never stored here. The
   *  team decides both who sees the role (with org admins/owners) and who is
   *  emailed when a report is ready. Named `projectShares` for history: the
   *  rows of the former "restricted" roles already meant exactly this. */
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
    // Set on team invitations, so the pending row can show a bounce.
    invitationId: v.optional(v.id('invitations')),
    createdAt: v.number(),
  })
    .index('by_org_and_created', ['orgId', 'createdAt'])
    .index('by_recipient', ['recipient'])
    .index('by_provider_id', ['providerId'])
    // Erasure has to be able to find every row that names a candidate, and
    // the report notification has to be able to ask "did I already send this
    // one?" exactly rather than by scanning the last 200 emails of the org.
    .index('by_session', ['sessionId'])
    .index('by_invitation', ['invitationId']),

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
      v.literal('org_delete'),
    ),
    objectsDeleted: v.number(),
    purgedAt: v.number(),
  })
    .index('by_org_and_purged', ['orgId', 'purgedAt'])
    .index('by_session', ['sessionId']),

  /** Which assistant threads a candidate's data was read into. A tool result
   *  is a copy of the candidate held in the agent component, where erasure
   *  cannot find it by content; this is how it finds it by session. Written
   *  in the same transaction as the read, so no tool result can reach a
   *  thread without its row. */
  chatThreadSessions: defineTable({
    threadId: v.string(),
    sessionId: v.id('sessions'),
  })
    .index('by_session', ['sessionId'])
    .index('by_thread_and_session', ['threadId', 'sessionId']),

  /** One-off data migrations that run themselves (convex/migrations.ts). A
   *  row per migration: `cutoff` is fixed on its first run, `doneAt` ends it
   *  for good. The cursor fields are where an unfinished pass stands. */
  migrations: defineTable({
    name: v.string(),
    cutoff: v.number(),
    doneAt: v.optional(v.number()),
    scopesCursor: v.optional(v.string()),
    scope: v.optional(v.string()),
    threadsCursor: v.optional(v.string()),
    foundInPass: v.optional(v.boolean()),
  }).index('by_name', ['name']),

  /** Every pipeline state transition, with its duration and outcome. This is
   *  what makes "a step can fail" observable instead of a lost session — and
   *  it is why there are no catch-up scripts. */
  jobLog: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    step: jobStepValidator,
    outcome: jobOutcomeValidator,
    /** The answer a `transcribe` row is about; one job runs per answer. */
    segmentId: v.optional(v.id('segments')),
    /** Which real attempt at this step (for this answer) the row belongs to,
     *  counted from the log itself — relaunches included. */
    attempt: v.number(),
    /** The operator behind a `relaunch`. An id, never an address: this log
     *  is read back on the recruiter's candidate page. */
    actorId: v.optional(v.id('users')),
    durationMs: v.optional(v.number()),
    error: v.optional(v.string()),
    /** What the step cost, when the provider says. Without these, "what does
     *  one interview cost?" has no answer at all — which is the question
     *  under every other question about pricing this product. */
    promptTokens: v.optional(v.number()),
    completionTokens: v.optional(v.number()),
    /** The part of `completionTokens` a reasoning model spent thinking —
     *  billed, never seen. Only when the provider reports it. */
    reasoningTokens: v.optional(v.number()),
    audioSeconds: v.optional(v.number()),
    at: v.number(),
  })
    .index('by_session', ['sessionId'])
    // Per answer, so counting one transcription's attempts does not read —
    // and conflict with — the rows its sibling answers are writing.
    .index('by_attempt', ['sessionId', 'step', 'segmentId', 'outcome'])
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

  /** Every change to a candidate's decision, newest last. `sessions` holds
   *  only the current one, so "who shortlisted them, and who rejected them
   *  after?" had no answer. Written by `reports.setDecision`, purged with the
   *  session. `decision` absent means the decision was cleared. */
  decisionEvents: defineTable({
    orgId: v.id('organizations'),
    sessionId: v.id('sessions'),
    decision: v.optional(recruiterDecisionValidator),
    /** An id, never an address, like `jobLog.actorId`. */
    actorId: v.id('users'),
    at: v.number(),
  }).index('by_session', ['sessionId', 'at']),
})
