/**
 * The candidate's interview, as a pure state machine.
 *
 * One state object, one case per transition, tested without a browser. An
 * event that makes no sense in the current phase is ignored rather than
 * half-applied: the runner's worst bugs — an error rendered in a branch the
 * finish screen never reached, a retry offered with nothing to retry — were
 * transitions nobody had written down.
 *
 * Side effects — the recorder, the upload, the Convex calls — stay in the
 * component. It performs them and reports what happened as events.
 *
 * Where the interview resumes is not decided here. The server derives it from
 * the segments it holds (`nextQuestionIndex` in convex/lib/sessionState.ts);
 * this machine starts from that value, and moving forward only ever skips
 * questions the server says are answered.
 */

export type Phase =
  | 'loading'
  | 'intro'
  /** A question on screen, not recording. */
  | 'prompt'
  | 'recording'
  /** Stopping the recorder, then uploading. */
  | 'saving'
  /** The recording is held, and did not reach the server. */
  | 'saveFailed'
  /** The recorder produced nothing, so there is nothing to send. */
  | 'recordingLost'
  /** Past the last question: what is missing, and the finish button. */
  | 'review'
  | 'finishing'
  | 'finishFailed'

/** Why the last recording stopped, when it was not the candidate's choice.
 *  `recovered`: it was found on this device after a reload, and sent. */
export type StopReason = 'finished' | 'timeUp' | 'interrupted' | 'recovered'

export type InterviewState = {
  phase: Phase
  /** Position in the question list; `total` once past the last question. */
  index: number
  total: number
  /** An i18n key, resolved by the screen. */
  error: string | null
  /** How much of the current answer is sent, and which attempt this is when
   *  the connection forced a retry. */
  progress: { percent: number; attempt: number; maxAttempts: number } | null
  stopReason: StopReason | null
  /** The last answer was saved as audio only: its video did not arrive. */
  videoLost: boolean
}

export type InterviewEvent =
  | {
      type: 'booted'
      /** From the server. Never computed on the client. */
      resumeAt: number
      total: number
      showIntro: boolean
    }
  | { type: 'introDone' }
  /** The camera or microphone could not be opened, or the recorder not started. */
  | { type: 'deviceFailed'; error: string }
  | { type: 'recordingStarted' }
  /** A take for the current question survived a reload and is being sent. */
  | { type: 'recovered' }
  | { type: 'stopRequested'; reason: StopReason }
  | { type: 'stopFailed' }
  | {
      type: 'progress'
      loaded: number
      total: number
      attempt: number
      maxAttempts: number
    }
  | {
      type: 'saved'
      /** Live from the server, one flag per question. */
      answered: ReadonlyArray<boolean>
      videoLost: boolean
    }
  | { type: 'saveFailed'; error: string }
  | { type: 'retry' }
  | { type: 'rerecord' }
  | { type: 'skip'; answered: ReadonlyArray<boolean> }
  | { type: 'revisit'; index: number }
  | { type: 'finishRequested' }
  | { type: 'finishFailed'; error: string }

export const initialInterviewState: InterviewState = {
  phase: 'loading',
  index: 0,
  total: 0,
  error: null,
  progress: null,
  stopReason: null,
  videoLost: false,
}

/**
 * The first question after `from` that has no answer, or `answered.length`
 * when there is none. Forward only: a question skipped earlier is offered
 * again on the review screen, not by jumping back mid-interview.
 */
export function nextOpenQuestion(
  answered: ReadonlyArray<boolean>,
  from: number,
): number {
  for (let index = from + 1; index < answered.length; index++) {
    if (!answered[index]) return index
  }
  return answered.length
}

/**
 * Whether the interview opens on the recruiter's intro: a video that can be
 * played, on a first visit. Anything else — no intro, a mode since retired, a
 * URL that could not be signed — goes straight to the first question, and the
 * candidate never sees an intro screen. One with nothing on it is a dead end.
 */
export function opensOnIntro(
  intro: { mode: 'none' | 'video'; url: string | null },
  answered: ReadonlyArray<boolean>,
): boolean {
  return (
    intro.mode === 'video' &&
    intro.url !== null &&
    answered.every((done) => !done)
  )
}

function moveTo(state: InterviewState, index: number): InterviewState {
  return {
    ...state,
    index,
    phase: index >= state.total ? 'review' : 'prompt',
    progress: null,
  }
}

/** Nothing about the previous answer carries over to a question it did not save. */
const cleared = { error: null, stopReason: null, videoLost: false } as const

export function interviewReducer(
  state: InterviewState,
  event: InterviewEvent,
): InterviewState {
  switch (event.type) {
    case 'booted': {
      if (state.phase !== 'loading') return state
      const booted = moveTo(
        { ...state, total: event.total },
        Math.min(event.resumeAt, event.total),
      )
      return event.showIntro && booted.phase === 'prompt'
        ? { ...booted, phase: 'intro' }
        : booted
    }

    case 'introDone':
      return state.phase === 'intro' ? { ...state, phase: 'prompt' } : state

    // Shown on the question screen, and "Start my answer" tries again; a
    // camera that could not be opened is not a reason to leave the page.
    case 'deviceFailed':
      return state.phase === 'intro' || state.phase === 'prompt'
        ? { ...state, error: event.error }
        : state

    case 'recordingStarted':
      return state.phase === 'prompt'
        ? { ...state, ...cleared, phase: 'recording' }
        : state

    // The same attempt, carried over a reload: it goes straight to saving,
    // and the screen says what happened once it lands.
    case 'recovered':
      return state.phase === 'intro' || state.phase === 'prompt'
        ? { ...state, ...cleared, phase: 'saving', stopReason: 'recovered' }
        : state

    case 'stopRequested':
      return state.phase === 'recording'
        ? {
            ...state,
            phase: 'saving',
            progress: null,
            stopReason: event.reason,
          }
        : state

    // No bytes came out of the recorder. The screen offers to record the
    // answer again — never a retry of nothing.
    case 'stopFailed':
      return state.phase === 'saving'
        ? { ...state, ...cleared, phase: 'recordingLost' }
        : state

    // Upload progress fires every few dozen milliseconds; the screen shows a
    // whole percentage, so anything finer would re-render it for nothing.
    case 'progress': {
      if (state.phase !== 'saving') return state
      const percent = Math.floor(
        (event.loaded / Math.max(1, event.total)) * 100,
      )
      return state.progress?.percent === percent &&
        state.progress.attempt === event.attempt
        ? state
        : {
            ...state,
            progress: {
              percent,
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
            },
          }
    }

    case 'saved': {
      if (state.phase !== 'saving') return state
      // The answer just saved counts as answered even if the live query has
      // not caught up with it yet.
      const answered = event.answered.map(
        (value, index) => value || index === state.index,
      )
      return {
        ...moveTo(state, nextOpenQuestion(answered, state.index)),
        error: null,
        videoLost: event.videoLost,
      }
    }

    case 'saveFailed':
      return state.phase === 'saving'
        ? { ...state, phase: 'saveFailed', error: event.error }
        : state

    case 'retry':
      return state.phase === 'saveFailed'
        ? { ...state, phase: 'saving', error: null, progress: null }
        : state

    case 'rerecord':
      return state.phase === 'recordingLost'
        ? { ...state, phase: 'prompt' }
        : state

    // Nothing was saved, so nothing may be announced as saved.
    case 'skip':
      return state.phase === 'saveFailed' || state.phase === 'recordingLost'
        ? {
            ...moveTo(state, nextOpenQuestion(event.answered, state.index)),
            ...cleared,
          }
        : state

    case 'revisit':
      return (state.phase === 'review' || state.phase === 'finishFailed') &&
        event.index >= 0 &&
        event.index < state.total
        ? { ...moveTo(state, event.index), ...cleared }
        : state

    case 'finishRequested':
      return state.phase === 'review' || state.phase === 'finishFailed'
        ? { ...state, phase: 'finishing', error: null }
        : state

    // Rendered on the review screen, where the button that failed is — not
    // inside a question block the finish screen never shows.
    case 'finishFailed':
      return state.phase === 'finishing'
        ? { ...state, phase: 'finishFailed', error: event.error }
        : state
  }
}

/**
 * An answer exists on this page and not on the server: leaving now loses it.
 * `saveFailed` counts — the bytes wait there for "Try again".
 */
export function answerAtRisk(phase: Phase): boolean {
  return phase === 'recording' || phase === 'saving' || phase === 'saveFailed'
}
