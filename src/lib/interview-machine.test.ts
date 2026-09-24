import { describe, expect, it } from 'vitest'

import {
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

const boot = (resumeAt: number, total = 4, showIntro = false) =>
  ({ type: 'booted', resumeAt, total, showIntro }) as const

/** Start recording the current question and stop it with `reason`. */
const record = (reason: 'finished' | 'timeUp' | 'interrupted' = 'finished') =>
  [
    { type: 'recordingStarted' },
    { type: 'stopRequested', reason },
    { type: 'recorded' },
  ] as const

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

  it('clamps a cursor outside the list', () => {
    expect(run([boot(9)]).index).toBe(4)
    expect(run([boot(-3)]).index).toBe(0)
  })

  it('shows the intro only when there is a question to go to', () => {
    expect(run([boot(0, 4, true)]).phase).toBe('intro')
    expect(run([boot(4, 4, true)]).phase).toBe('review')
    expect(run([boot(0, 4, true), { type: 'introDone' }]).phase).toBe('prompt')
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
      { type: 'recordingFailed', error: 'interview:device.busy' },
    ])
    expect(state).toMatchObject({
      phase: 'prompt',
      error: 'interview:device.busy',
    })
    expect(interviewReducer(state, { type: 'recordingStarted' }).phase).toBe(
      'recording',
    )
  })

  it('carries a camera failure found during the intro onto the question', () => {
    const state = run([
      boot(0, 4, true),
      { type: 'deviceFailed', error: 'interview:device.permissionDenied' },
      { type: 'introDone' },
    ])
    expect(state.error).toBe('interview:device.permissionDenied')
  })

  it('reports upload progress only while saving', () => {
    const saving = run([boot(0), { type: 'recordingStarted' }, { type: 'stopRequested', reason: 'finished' }])
    expect(
      interviewReducer(saving, { type: 'progress', loaded: 5, total: 10 })
        .progress,
    ).toEqual({ loaded: 5, total: 10 })
    expect(
      interviewReducer(run([boot(0)]), { type: 'progress', loaded: 5, total: 10 })
        .progress,
    ).toBeNull()
  })
})

describe('a failed save', () => {
  it('re-sends the held recording', () => {
    const failed = run([
      boot(0),
      ...record(),
      { type: 'saveFailed', error: 'interview:run.sendFailed.body' },
    ])
    expect(failed).toMatchObject({ phase: 'saveFailed', hasRecording: true })
    expect(interviewReducer(failed, { type: 'retry' }).phase).toBe('saving')
  })

  /**
   * E7. When `recorder.stop()` threw, the old runner showed "Try again" with
   * nothing held — a button that did nothing at all.
   */
  it('offers to record again, not to retry, when no bytes came out', () => {
    const failed = run([
      boot(1),
      { type: 'recordingStarted' },
      { type: 'stopRequested', reason: 'finished' },
      { type: 'stopFailed', error: 'interview:run.recordingLost' },
    ])
    expect(failed).toMatchObject({ phase: 'saveFailed', hasRecording: false })
    expect(interviewReducer(failed, { type: 'retry' })).toBe(failed)

    const again = interviewReducer(failed, { type: 'rerecord' })
    expect(again).toMatchObject({ phase: 'prompt', index: 1, error: null })
  })

  it('never announces as saved an answer that was not', () => {
    const lost = run([
      boot(0),
      { type: 'recordingStarted' },
      { type: 'stopRequested', reason: 'interrupted' },
      { type: 'stopFailed', error: 'x' },
    ])
    expect(lost.stopReason).toBeNull()

    const skipped = run([
      boot(0),
      ...record('timeUp'),
      { type: 'saveFailed', error: 'x' },
      { type: 'skip', answered: [false, false, false, false] },
    ])
    expect(skipped).toMatchObject({ stopReason: null, videoLost: false })
  })

  it('does not offer to record again while bytes are still held', () => {
    const failed = run([
      boot(0),
      ...record(),
      { type: 'saveFailed', error: 'x' },
    ])
    expect(interviewReducer(failed, { type: 'rerecord' })).toBe(failed)
  })

  it('drops the recording and moves on when the candidate skips', () => {
    const state = run([
      boot(0),
      ...record(),
      { type: 'saveFailed', error: 'x' },
      { type: 'skip', answered: [false, true, false, false] },
    ])
    expect(state).toMatchObject({
      phase: 'prompt',
      index: 2,
      hasRecording: false,
      error: null,
    })
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
      { type: 'recorded' },
      { type: 'retry' },
      { type: 'skip', answered: [false, false, false, false] },
      { type: 'finishRequested' },
      { type: 'finishFailed', error: 'x' },
      { type: 'revisit', index: 2 },
    ] as const) {
      expect(interviewReducer(prompt, event)).toBe(prompt)
    }
  })
})
