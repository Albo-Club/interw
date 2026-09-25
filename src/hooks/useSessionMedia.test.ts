import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  FRESH_SIGNATURE_MS,
  RESIGN_AFTER_MS,
  createMediaSigner,
  sessionMediaKey,
} from './useSessionMedia'

/**
 * Audit 2026-09-15, recruiter E3. Playback URLs were signed once, so an hour
 * into a review every citation's "jump to" silently did nothing; and they
 * were re-signed on every write to the session, so saving a note sent the
 * video back to the start.
 */
describe('playback URL signing', () => {
  let sign: ReturnType<typeof vi.fn<() => Promise<number>>>
  let media: Array<number>
  let failures: number

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    let n = 0
    sign = vi.fn(() => Promise.resolve(++n))
    media = []
    failures = 0
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const start = () => {
    const signer = createMediaSigner({
      sign,
      onMedia: (value) => media.push(value),
      onFailed: () => (failures += 1),
    })
    signer.retry()
    return signer
  }

  it('re-signs before the URLs expire, and keeps doing so', async () => {
    start()
    await vi.advanceTimersByTimeAsync(0)
    expect(media).toEqual([1])

    await vi.advanceTimersByTimeAsync(RESIGN_AFTER_MS)
    expect(media).toEqual([1, 2])
    await vi.advanceTimersByTimeAsync(RESIGN_AFTER_MS)
    expect(media).toEqual([1, 2, 3])
    // Before the hour the URLs are good for, every time.
    expect(RESIGN_AFTER_MS).toBeLessThan(60 * 60 * 1000)
  })

  it('re-signs when the player reports an error on an old URL', async () => {
    const signer = start()
    await vi.advanceTimersByTimeAsync(FRESH_SIGNATURE_MS + 1)
    signer.onPlaybackError()
    await vi.advanceTimersByTimeAsync(0)
    expect(media).toEqual([1, 2])
    expect(failures).toBe(0)
  })

  it('shows a failure, rather than looping, when a fresh URL will not play', async () => {
    const signer = start()
    await vi.advanceTimersByTimeAsync(0)
    signer.onPlaybackError()
    await vi.advanceTimersByTimeAsync(0)
    expect(sign).toHaveBeenCalledTimes(1)
    expect(failures).toBe(1)
  })

  it('shows a failure when signing itself fails', async () => {
    sign.mockImplementationOnce(() => Promise.reject(new Error('offline')))
    start()
    await vi.advanceTimersByTimeAsync(0)
    expect(media).toEqual([])
    expect(failures).toBe(1)
  })

  it('stops for good once the page lets go of it', async () => {
    const signer = start()
    signer.stop()
    await vi.advanceTimersByTimeAsync(RESIGN_AFTER_MS * 2)
    // The answer to the request in flight is dropped, and nothing is scheduled.
    expect(media).toEqual([])
    expect(sign).toHaveBeenCalledTimes(1)
  })
})

describe('what the candidate page signs for', () => {
  const data = {
    session: {
      _id: 's1',
      hasCv: true,
      hasCoverLetter: false,
      mediaPurgedAt: null,
      recruiterNote: 'first thoughts',
      recruiterDecision: null as string | null,
    },
    answers: [
      { segmentId: 'a', uploadState: 'uploaded', transcript: null },
      { segmentId: 'b', uploadState: 'pending', transcript: null },
    ],
    pipeline: [] as Array<unknown>,
  }

  it('does not change when a note, a decision or a pipeline step is written', () => {
    const before = sessionMediaKey(data)
    // Through a variable: the extra fields are the point, and a literal
    // argument would have them rejected as excess properties.
    const written = {
      ...data,
      session: {
        ...data.session,
        recruiterNote: 'second thoughts',
        recruiterDecision: 'shortlisted',
      },
      answers: data.answers.map((answer) => ({
        ...answer,
        transcript: 'now transcribed',
      })),
      pipeline: [{ step: 'report' }],
    }
    expect(sessionMediaKey(written)).toBe(before)
  })

  it('changes when there is something new to play, or nothing left', () => {
    const before = sessionMediaKey(data)
    expect(
      sessionMediaKey({
        ...data,
        answers: data.answers.map((answer) => ({
          ...answer,
          uploadState: 'uploaded',
        })),
      }),
    ).not.toBe(before)
    expect(
      sessionMediaKey({
        ...data,
        session: { ...data.session, mediaPurgedAt: 1 },
      }),
    ).not.toBe(before)
  })
})
