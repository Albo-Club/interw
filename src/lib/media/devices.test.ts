import { describe, expect, it, vi } from 'vitest'

import {
  assessMicLevels,
  classifyMediaError,
  detectBrowserSupport,
  isInAppBrowser,
  levelFromTimeDomain,
  openInterviewStream,
} from './devices'

describe('isInAppBrowser', () => {
  // Candidates open their email in the LinkedIn or Gmail app; the link opens
  // in a webview where recording fails. Catching it costs one screen; missing
  // it costs the interview.
  it.each([
    ['LinkedIn', 'Mozilla/5.0 (iPhone) LinkedInApp/9.2.1'],
    ['Facebook', 'Mozilla/5.0 (iPhone) [FBAN/FBIOS;FBAV/400.0]'],
    ['Instagram', 'Mozilla/5.0 (iPhone) Instagram 250.0.0.0'],
    ['WeChat', 'Mozilla/5.0 (iPhone) MicroMessenger/8.0'],
    ['Google app', 'Mozilla/5.0 (iPhone) GSA/280.0'],
    ['Android WebView', 'Mozilla/5.0 (Linux; Android 13; wv) Chrome/120'],
  ])('flags %s', (_name, userAgent) => {
    expect(isInAppBrowser(userAgent)).toBe(true)
  })

  it.each([
    ['Chrome desktop', 'Mozilla/5.0 (Macintosh) Chrome/120.0 Safari/537.36'],
    ['Safari iOS', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Version/17.0 Safari/605'],
    ['Firefox', 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/121.0'],
  ])('does not flag %s', (_name, userAgent) => {
    expect(isInAppBrowser(userAgent)).toBe(false)
  })
})

describe('detectBrowserSupport', () => {
  const chrome = {
    navigator: {
      mediaDevices: { getUserMedia: () => undefined },
      userAgent: 'Chrome/120',
    },
    MediaRecorder: function MediaRecorder() {},
    AudioContext: function AudioContext() {},
  }

  it('accepts a modern browser', () => {
    expect(detectBrowserSupport(chrome as never)).toMatchObject({
      getUserMedia: true,
      mediaRecorder: true,
      usable: true,
      inAppBrowser: false,
    })
  })

  it('refuses a browser with no MediaRecorder', () => {
    const { MediaRecorder: _dropped, ...withoutRecorder } = chrome
    expect(detectBrowserSupport(withoutRecorder as never).usable).toBe(false)
  })

  it('refuses a browser with no getUserMedia', () => {
    expect(
      detectBrowserSupport({
        ...chrome,
        navigator: { userAgent: 'Old/1.0' },
      }).usable,
    ).toBe(false)
  })

  it('survives being handed nothing at all', () => {
    expect(detectBrowserSupport({}).usable).toBe(false)
  })
})

describe('levelFromTimeDomain', () => {
  it('is zero for digital silence', () => {
    expect(levelFromTimeDomain(new Uint8Array(128).fill(128))).toBe(0)
  })

  it('rises with amplitude', () => {
    const quiet = levelFromTimeDomain(new Uint8Array(128).fill(132))
    const loud = levelFromTimeDomain(new Uint8Array(128).fill(200))
    expect(loud).toBeGreaterThan(quiet)
    expect(loud).toBeLessThanOrEqual(1)
  })

  it('handles an empty frame', () => {
    expect(levelFromTimeDomain(new Uint8Array(0))).toBe(0)
  })
})

describe('assessMicLevels', () => {
  it('calls a dead microphone silent', () => {
    expect(assessMicLevels([0, 0, 0.001, 0])).toBe('silent')
  })

  it('warns about a microphone that barely picks up', () => {
    expect(assessMicLevels([0.01, 0.03, 0.04])).toBe('quiet')
  })

  it('accepts a normal speaking voice', () => {
    expect(assessMicLevels([0.01, 0.2, 0.05])).toBe('good')
  })

  // Someone who says one sentence then waits has a working microphone;
  // averaging over the pause would wrongly call it silent.
  it('judges on the loudest moment, not the average', () => {
    expect(assessMicLevels([0, 0, 0, 0.3, 0, 0, 0])).toBe('good')
  })

  it('treats no samples as silence', () => {
    expect(assessMicLevels([])).toBe('silent')
  })
})

const domError = (name: string) => Object.assign(new Error(name), { name })

/** M1. Only `NotFoundError` was told apart; a busy camera read as "refused". */
describe('classifyMediaError', () => {
  it.each([
    ['NotAllowedError', 'permissionDenied'],
    ['SecurityError', 'permissionDenied'],
    ['NotReadableError', 'busy'],
    ['AbortError', 'busy'],
    ['NotFoundError', 'noDevices'],
    ['OverconstrainedError', 'noDevices'],
  ] as const)('%s means %s', (name, failure) => {
    expect(classifyMediaError(domError(name))).toBe(failure)
  })

  it('does not pretend to explain what it cannot', () => {
    expect(classifyMediaError(new TypeError('bad constraints'))).toBeNull()
    expect(classifyMediaError('nope')).toBeNull()
  })
})

describe('openInterviewStream', () => {
  const stream = {} as MediaStream

  /** E1. The interview reopened the defaults and ignored the choice. */
  it('opens the devices chosen on the check screen', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    await openInterviewStream(
      { cameraId: 'cam-2', micId: 'mic-2', video: true },
      getUserMedia,
    )
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({ deviceId: { exact: 'mic-2' } }),
      video: expect.objectContaining({ deviceId: { exact: 'cam-2' } }),
    })
  })

  it('asks for mono speech with echo cancellation, and caps the frame rate', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    await openInterviewStream({ video: true }, getUserMedia)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.objectContaining({
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1,
      }),
      video: expect.objectContaining({ frameRate: { ideal: 24, max: 30 } }),
    })
  })

  /** A headset unplugged since the check used to cost the camera. */
  it('opens the defaults, camera included, when the chosen device is gone', async () => {
    const getUserMedia = vi
      .fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()
      .mockRejectedValueOnce(domError('OverconstrainedError'))
      .mockResolvedValueOnce(stream)
    const result = await openInterviewStream(
      { cameraId: 'cam-gone', micId: 'mic-gone', video: true },
      getUserMedia,
    )
    expect(result).toEqual({ stream, audioOnly: false })
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
      video: expect.objectContaining({ facingMode: 'user' }),
    })
  })

  /** M7. Nothing guaranteed the front camera on a phone. */
  it('asks for the front camera when none was chosen', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    await openInterviewStream({ video: true }, getUserMedia)
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.objectContaining({ facingMode: 'user' }),
      }),
    )
  })

  /** E2. A webcam held by a video call used to cost the whole interview. */
  it.each(['NotReadableError', 'NotFoundError', 'OverconstrainedError'])(
    'records audio only after %s',
    async (name) => {
      const getUserMedia = vi
        .fn<(c: MediaStreamConstraints) => Promise<MediaStream>>()
        .mockRejectedValueOnce(domError(name))
        .mockResolvedValueOnce(stream)
      const result = await openInterviewStream({ video: true }, getUserMedia)
      expect(result).toEqual({ stream, audioOnly: true })
      expect(getUserMedia).toHaveBeenLastCalledWith({
        audio: expect.anything(),
        video: false,
      })
    },
  )

  it('does not ask again after the candidate refused', async () => {
    const getUserMedia = vi.fn(() =>
      Promise.reject(domError('NotAllowedError')),
    )
    await expect(
      openInterviewStream({ video: true }, getUserMedia),
    ).rejects.toThrow('NotAllowedError')
    expect(getUserMedia).toHaveBeenCalledTimes(1)
  })

  it('opens the microphone alone when the browser cannot record video', async () => {
    const getUserMedia = vi.fn(() => Promise.resolve(stream))
    const result = await openInterviewStream({ video: false }, getUserMedia)
    expect(result.audioOnly).toBe(true)
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: expect.anything(),
      video: false,
    })
  })
})
