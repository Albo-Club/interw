import { describe, expect, it } from 'vitest'

import {
  assessMicLevels,
  detectBrowserSupport,
  isInAppBrowser,
  levelFromTimeDomain,
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
