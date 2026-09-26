import { describe, expect, it } from 'vitest'

import {
  answerAtRisk,
  initialInterviewState,
  interviewReducer,
  nextOpenQuestion,
} from './interview-machine'
import type { InterviewEvent, InterviewState } from './interview-machine'

function run(
  events: ReadonlyArray<InterviewEvent>,
  from: InterviewState = initialInterviewState,
): InterviewState {
  return events.reduce(interviewReducer, from)
}

const boot = (resumeAt: number, total = 4) =>
  ({ type: 'booted', resumeAt, total }) as const

/** Start recording the current question and stop it with `reason`. */
const record = (reason: 'finished' | 'timeUp' | 'interrupted' = 'finished') =>
  [{ type: 'recordingStarted' }, { type: 'stopRequested', reason }] as const

describe('nextOpenQuestion', () => {
  it('skips answered questions and never looks back', () => {
    expect(nextOpenQuestion([false, false, true, false], 1)).toBe(3)
    expect(nextOpenQuestion([false, true, true, true], 1)).toBe(4)
  })
})

describe('booting', () => {
  it('starts where the server says, not at the first unanswered question', () => {
    const state = run([boot(2)])
    expect(state).toMatchObject({ phase: 'prompt', index: 2, total: 4 })
  })

  it('goes straight to the review screen when everything is answered', () => {
    expect(run([boot(4)]).phase).toBe('review')
  })

  it('clamps a cursor past the end of the list', () => {
    expect(run([boot(9)])).toMatchObject({ phase: 'review', index: 4 })
  })

  it('boots once', () => {
    const state = run([boot(1), boot(3)])
    expect(state.index).toBe(1)
  })
})

/**
 * E6. The old runner resumed at its own `firstUnanswered`, then advanced by
 * `index + 1` — straight into an answer already saved, which it re-recorded
 * over the first one in the bucket.
 */
describe('resuming after a failed answer', () => {
  it('moves past answers the server already holds', () => {
    // q1 failed, q2 saved: the server resumes at q1.
    const state = run([
      boot(1),
      ...record(),
      { type: 'saved', answered: [true, false, true, false], videoLost: false },
    ])
    expect(state).toMatchObject({ phase: 'prompt', index: 3 })
  })

  it('treats the answer just saved as answered before the query catches up', () => {
    const state = run([
      boot(0, 2),
      ...record(),
      { type: 'saved', answered: [false, false], videoLost: false },
    ])
    expect(state.index).toBe(1)
  })

  it('reaches the review screen after the last open question', () => {
    const state = run([
      boot(3),
      ...record(),
      { type: 'saved', answered: [true, false, true, false], videoLost: false },
    ])
    expect(state.phase).toBe('review')
  })
})

describe('an answer recovered after a reload', () => {
  it('is sent straight away, and announced once it lands', () => {
    const sending = run([boot(1), { type: 'recovered' }])
    expect(sending).toMatchObject({ phase: 'saving', index: 1 })
    const saved = run(
      [{ type: 'saved', answered: [true, false, false, false], videoLost: false }],
      sending,
    )
    expect(saved).toMatchObject({ phase: 'prompt', index: 2, stopReason: 'recovered' })
  })

  it('offers the usual retry when it does not get through', () => {
    const failed = run([
      boot(0),
      { type: 'recovered' },
      { type: 'saveFailed', error: 'interview:errors.network' },
    ])
    expect(failed.phase).toBe('saveFailed')
    expect(run([{ type: 'retry' }], failed).phase).toBe('saving')
  })

  it('is ignored mid-recording', () => {
    const recording = run([boot(0), { type: 'recordingStarted' }])
    expect(run([{ type: 'recovered' }], recording)).toBe(recording)
  })
})

describe('recording', () => {
  it('clears the previous answer’s notices when a new one starts', () => {
    const state = run([
      boot(0),
      ...record('timeUp'),
      { type: 'saved', answered: [true, false, false, false], videoLost: true },
      { type: 'recordingStarted' },
    ])
    expect(state).toMatchObject({
      phase: 'recording',
      stopReason: null,
      videoLost: false,
      error: null,
    })
  })

  it('keeps why the answer stopped, to tell the candidate after it saves', () => {
    const state = run([
      boot(0),
      ...record('interrupted'),
      { type: 'saved', answered: [true, false, false, false], videoLost: false },
    ])
    expect(state.stopReason).toBe('interrupted')
  })

  it('says when an answer arrived without its video', () => {
    const state = run([
      boot(0),
      ...record(),
      { type: 'saved', answered: [true, false, false, false], videoLost: true },
    ])
    expect(state.videoLost).toBe(true)
  })

  it('shows a camera failure on the question and lets the candidate try again', () => {
    const state = run([
      boot(0),
      { type: 'deviceFailed', error: 'interview:device.busy' },
    ])
    expect(state).toMatchObject({
      phase: 'prompt',
      error: 'interview:device.busy',
    })
    expect(interviewReducer(state, { type: 'recordingStarted' }).phase).toBe(
      'recording',
    )
  })

  it('reports upload progress only while saving', () => {
    const progress = {
      type: 'progress',
      loaded: 5,
      total: 10,
      attempt: 2,
      maxAttempts: 3,
    } as const
    const saving = run([boot(0), ...record()])
    expect(interviewReducer(saving, progress).progress).toEqual({
      percent: 50,
      attempt: 2,
      maxAttempts: 3,
    })
    expect(interviewReducer(run([boot(0)]), progress).progress).toBeNull()
  })

  it('does not re-render for progress the screen cannot show', () => {
    const at = (loaded: number) =>
      ({ type: 'progress', loaded, total: 1000, attempt: 1, maxAttempts: 3 }) as const
    const first = interviewReducer(run([boot(0), ...record()]), at(501))
    expect(interviewReducer(first, at(505))).toBe(first)
    expect(interviewReducer(first, at(510))).not.toBe(first)
  })
})

describe('a failed save', () => {
  it('re-sends the held recording', () => {
    const failed = run([
      boot(0),
      ...record(),
      { type: 'saveFailed', error: 'interview:run.sendFailed.body' },
    ])
    expect(failed.phase).toBe('saveFailed')
    expect(interviewReducer(failed, { type: 'retry' }).phase).toBe('saving')
  })

  /**
   * E7. When `recorder.stop()` threw, the old runner showed "Try again" with
   * nothing held — a button that did nothing at all.
   */
  it('offers to record again, not to retry, when no bytes came out', () => {
    const failed = run([boot(1), ...record(), { type: 'stopFailed' }])
    expect(failed.phase).toBe('recordingLost')
    expect(interviewReducer(failed, { type: 'retry' })).toBe(failed)

    const again = interviewReducer(failed, { type: 'rerecord' })
    expect(again).toMatchObject({ phase: 'prompt', index: 1, error: null })
  })

  it('never announces as saved an answer that was not', () => {
    const lost = run([boot(0), ...record('interrupted'), { type: 'stopFailed' }])
    expect(lost.stopReason).toBeNull()

    const skipped = run([
      boot(0),
      ...record('timeUp'),
      { type: 'saveFailed', error: 'x' },
      { type: 'skip', answered: [false, false, false, false] },
    ])
    expect(skipped).toMatchObject({ stopReason: null, videoLost: false })
  })

  it('lets the candidate skip an answer that could not be recorded', () => {
    const state = run([
      boot(0),
      ...record(),
      { type: 'stopFailed' },
      { type: 'skip', answered: [false, false, false, false] },
    ])
    expect(state).toMatchObject({ phase: 'prompt', index: 1 })
  })

  it('does not offer to record again while bytes are still held', () => {
    const failed = run([
      boot(0),
      ...record(),
      { type: 'saveFailed', error: 'x' },
    ])
    expect(interviewReducer(failed, { type: 'rerecord' })).toBe(failed)
  })

  it('moves on when the candidate skips a failed save', () => {
    const state = run([
      boot(0),
      ...record(),
      { type: 'saveFailed', error: 'x' },
      { type: 'skip', answered: [false, true, false, false] },
    ])
    expect(state).toMatchObject({ phase: 'prompt', index: 2, error: null })
  })
})

/**
 * E3 / B9. A failed finish rendered nothing: the alert lived in the branch for
 * an unfinished question. It is a phase of the review screen now.
 */
describe('finishing', () => {
  const review = run([boot(4)])

  it('keeps a failed finish on the review screen, with its error', () => {
    const state = run(
      [
        { type: 'finishRequested' },
        { type: 'finishFailed', error: 'interview:errors.rate_limited' },
      ],
      review,
    )
    expect(state).toMatchObject({
      phase: 'finishFailed',
      error: 'interview:errors.rate_limited',
    })
  })

  it('lets the candidate press finish again after a failure', () => {
    const state = run(
      [
        { type: 'finishRequested' },
        { type: 'finishFailed', error: 'x' },
        { type: 'finishRequested' },
      ],
      review,
    )
    expect(state).toMatchObject({ phase: 'finishing', error: null })
  })

  it('goes back to a missing answer from the review screen', () => {
    const state = interviewReducer(review, { type: 'revisit', index: 1 })
    expect(state).toMatchObject({ phase: 'prompt', index: 1 })
  })

  it('refuses to revisit a question that does not exist', () => {
    expect(interviewReducer(review, { type: 'revisit', index: 4 })).toBe(review)
  })
})

describe('events out of place', () => {
  it('are ignored rather than half-applied', () => {
    const prompt = run([boot(0)])
    for (const event of [
      { type: 'saved', answered: [true, true, true, true], videoLost: false },
      { type: 'stopRequested', reason: 'finished' },
      { type: 'stopFailed' },
      { type: 'retry' },
      { type: 'rerecord' },
      { type: 'skip', answered: [false, false, false, false] },
      { type: 'finishRequested' },
      { type: 'finishFailed', error: 'x' },
      { type: 'revisit', index: 2 },
    ] as const) {
      expect(interviewReducer(prompt, event)).toBe(prompt)
    }
  })
})

/** Cand M12: `saveFailed` holds unsent bytes and was left unguarded. */
describe('answerAtRisk', () => {
  it('guards every phase where an answer is on the page and not on the server', () => {
    const phases = [
      'loading',
      'prompt',
      'recording',
      'saving',
      'saveFailed',
      'recordingLost',
      'review',
      'finishing',
      'finishFailed',
    ] as const
    expect(phases.filter(answerAtRisk)).toEqual([
      'recording',
      'saving',
      'saveFailed',
    ])
  })
})
