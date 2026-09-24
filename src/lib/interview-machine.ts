/**
 * The candidate's interview, as a pure state machine.
 *
 * This used to be eight `useState`, five `useRef` and an implicit phase spread
 * over four callbacks in the route component. Three bugs came from that shape
 * rather than from inattention: an error rendered inside a branch the finish
 * screen never reached, two resume cursors that disagreed, and a failure
 * branch that offered a retry with nothing to retry. Here every transition is
 * one line of `interviewReducer`, tested without a browser, and an event that
 * makes no sense in the current phase is ignored instead of half-applied.
 *
 * Side effects — the recorder, the upload, the Convex calls — stay in the
 * component. It performs them and reports what happened as events.
 *
 * Where the interview resumes is not decided here. The server derives it from
 * the segments it holds (`nextQuestionIndex` in convex/interview.ts) and this
 * machine starts from that value; moving forward only ever skips questions the
 * server says are answered.
 */

export type Phase =
  | 'loading'
  | 'intro'
  /** A question on screen, not recording. */
  | 'prompt'
  | 'recording'
  /** Stopping the recorder, then uploading. */
  | 'saving'
  /** The answer did not reach the server. */
  | 'saveFailed'
  /** Past the last question: what is missing, and the finish button. */
  | 'review'
  | 'finishing'
  | 'finishFailed'

/** Why the last recording stopped, when it was not the candidate's choice. */
export type StopReason = 'finished' | 'timeUp' | 'interrupted'

export type InterviewState = {
  phase: Phase
  /** Position in the question list; `total` once past the last question. */
  index: number
  total: number
  /** A finished recording is held, so "Try again" has bytes to re-send. */
  hasRecording: boolean
  /** An i18n key, resolved by the screen. */
  error: string | null
  /** Bytes sent of the current answer, across its audio and video files. */
  progress: { loaded: number; total: number } | null
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
  | { type: 'deviceFailed'; error: string }
  | { type: 'recordingStarted' }
  | { type: 'recordingFailed'; error: string }
  | { type: 'stopRequested'; reason: StopReason }
  | { type: 'recorded' }
  | { type: 'stopFailed'; error: string }
  | { type: 'progress'; loaded: number; total: number }
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
  hasRecording: false,
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

function moveTo(state: InterviewState, index: number): InterviewState {
  return {
    ...state,
    index,
    phase: index >= state.total ? 'review' : 'prompt',
    hasRecording: false,
    progress: null,
  }
}

export function interviewReducer(
  state: InterviewState,
  event: InterviewEvent,
): InterviewState {
  switch (event.type) {
    case 'booted': {
      if (state.phase !== 'loading') return state
      const booted = moveTo(
        { ...state, total: event.total },
        Math.min(Math.max(0, event.resumeAt), event.total),
      )
      return event.showIntro && booted.phase === 'prompt'
        ? { ...booted, phase: 'intro' }
        : booted
    }

    case 'introDone':
      return state.phase === 'intro' ? { ...state, phase: 'prompt' } : state

    // A camera that could not be opened is shown on the question screen, and
    // "Start my answer" tries again; it is not a reason to leave the page.
    case 'deviceFailed':
    case 'recordingFailed':
      return state.phase === 'intro' || state.phase === 'prompt'
        ? { ...state, error: event.error }
        : state

    case 'recordingStarted':
      return state.phase === 'prompt'
        ? {
            ...state,
            phase: 'recording',
            error: null,
            stopReason: null,
            videoLost: false,
          }
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

    case 'recorded':
      return state.phase === 'saving' ? { ...state, hasRecording: true } : state

    // No bytes came out of the recorder. The screen must still offer a way
    // on — recording the answer again — rather than a retry of nothing.
    case 'stopFailed':
      return state.phase === 'saving'
        ? {
            ...state,
            phase: 'saveFailed',
            hasRecording: false,
            error: event.error,
          }
        : state

    case 'progress':
      return state.phase === 'saving'
        ? { ...state, progress: { loaded: event.loaded, total: event.total } }
        : state

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
      return state.phase === 'saveFailed' && state.hasRecording
        ? { ...state, phase: 'saving', error: null, progress: null }
        : state

    case 'rerecord':
      return state.phase === 'saveFailed' && !state.hasRecording
        ? { ...state, phase: 'prompt', error: null, progress: null }
        : state

    case 'skip':
      return state.phase === 'saveFailed'
        ? {
            ...moveTo(state, nextOpenQuestion(event.answered, state.index)),
            error: null,
          }
        : state

    case 'revisit':
      return (state.phase === 'review' || state.phase === 'finishFailed') &&
        event.index >= 0 &&
        event.index < state.total
        ? { ...moveTo(state, event.index), error: null, stopReason: null }
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
