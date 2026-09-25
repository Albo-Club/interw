import { describe, expect, it } from 'vitest'

import { maxInterviewMinutes } from './interviewDuration'

const q = (maxResponseSeconds: number) => ({ maxResponseSeconds })

describe('maxInterviewMinutes', () => {
  it('is zero for a role with no questions yet', () => {
    expect(maxInterviewMinutes([])).toBe(0)
  })

  it('adds the time to read each question to its answer time', () => {
    // 3 × (120 s + 30 s) = 450 s = 7.5 min.
    expect(maxInterviewMinutes([q(120), q(120), q(120)])).toBe(8)
  })

  it('rounds up, never down: it is the time to set aside', () => {
    expect(maxInterviewMinutes([q(30)])).toBe(1)
    expect(maxInterviewMinutes([q(31)])).toBe(2)
  })

  // The incident that retired the role-level field: a recruiter set 30 min on
  // a role whose questions took longer. Nothing typed by hand can disagree
  // with the questions any more.
  it('follows the questions, however long they are', () => {
    expect(maxInterviewMinutes(Array.from({ length: 10 }, () => q(600)))).toBe(
      105,
    )
  })
})
