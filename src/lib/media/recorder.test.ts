import { describe, expect, it } from 'vitest'

import {
  AUDIO_MIME_PREFERENCES,
  VIDEO_MIME_PREFERENCES,
  detectRecorderSupport,
  pickSupportedMimeType,
} from './recorder'

const supports = (...types: Array<string>) => (type: string) =>
  types.includes(type)

describe('pickSupportedMimeType', () => {
  it('takes the first supported entry, not the first listed', () => {
    expect(
      pickSupportedMimeType(
        VIDEO_MIME_PREFERENCES,
        supports('video/webm', 'video/mp4'),
      ),
    ).toBe('video/webm')
  })

  it('returns null when nothing is supported', () => {
    expect(pickSupportedMimeType(VIDEO_MIME_PREFERENCES, () => false)).toBeNull()
  })
})

describe('detectRecorderSupport', () => {
  it('prefers VP9 WebM on Chrome-like browsers', () => {
    const support = detectRecorderSupport(
      supports(
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        'audio/webm;codecs=opus',
        'audio/webm',
      ),
    )
    expect(support.video).toBe('video/webm;codecs=vp9,opus')
    expect(support.audio).toBe('audio/webm;codecs=opus')
    expect(support.usable).toBe(true)
  })

  it('falls back to MP4 on Safari', () => {
    const support = detectRecorderSupport(supports('video/mp4', 'audio/mp4'))
    expect(support.video).toBe('video/mp4')
    expect(support.audio).toBe('audio/mp4')
    expect(support.usable).toBe(true)
  })

  // Audio is what gets transcribed, so no audio format means no interview —
  // and the candidate has to be told before they start, not after.
  it('is unusable without any audio format, even if video works', () => {
    const support = detectRecorderSupport(supports('video/webm'))
    expect(support.video).toBe('video/webm')
    expect(support.audio).toBeNull()
    expect(support.usable).toBe(false)
  })

  it('stays usable on an audio-only browser', () => {
    const support = detectRecorderSupport(supports('audio/webm'))
    expect(support.video).toBeNull()
    expect(support.usable).toBe(true)
  })

  it('lists audio preferences with a Safari branch', () => {
    expect(AUDIO_MIME_PREFERENCES).toContain('audio/mp4')
  })
})
