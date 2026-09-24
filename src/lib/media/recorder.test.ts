import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AUDIO_MIME_PREFERENCES,
  CHUNK_INTERVAL_MS,
  NO_DATA_TIMEOUT_SECONDS,
  STOP_TIMEOUT_MS,
  SegmentRecorder,
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
    ).toBe('video/mp4')
  })

  it('returns null when nothing is supported', () => {
    expect(pickSupportedMimeType(VIDEO_MIME_PREFERENCES, () => false)).toBeNull()
  })
})

describe('detectRecorderSupport', () => {
  it('falls back to VP9 WebM where MP4 cannot be recorded (Firefox)', () => {
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

  it('prefers H.264/AAC MP4 wherever it can be recorded', () => {
    const support = detectRecorderSupport(
      supports(
        'video/mp4;codecs=avc1,mp4a.40.2',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'audio/webm;codecs=opus',
      ),
    )
    expect(support.video).toBe('video/mp4;codecs=avc1,mp4a.40.2')
    // The audio stays WebM/Opus: the transcription path already takes it.
    expect(support.audio).toBe('audio/webm;codecs=opus')
  })

  it('takes plain MP4 on a Safari that answers no codec query', () => {
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

/* ── SegmentRecorder, against a fake MediaRecorder ─────────────────────── */

type Behaviour = 'normal' | 'hang' | 'empty'

class FakeRecorder {
  static instances: Array<FakeRecorder> = []
  static behaviour: Record<string, Behaviour> = {}
  state: 'inactive' | 'recording' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror: (() => void) | null = null

  constructor(
    readonly stream: { kind: string },
    readonly options: MediaRecorderOptions,
  ) {
    FakeRecorder.instances.push(this)
  }

  timeslice: number | undefined

  start(timeslice?: number) {
    this.timeslice = timeslice
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    const behaviour = FakeRecorder.behaviour[this.stream.kind] ?? 'normal'
    if (behaviour === 'hang') return
    if (behaviour === 'normal') this.ondataavailable?.({ data: new Blob(['x']) })
    this.onstop?.()
  }
}

function fakeStream({ video }: { video: boolean }) {
  return {
    kind: 'camera',
    getAudioTracks: () => [{ kind: 'audio' }],
    getVideoTracks: () => (video ? [{ kind: 'video' }] : []),
  } as unknown as MediaStream
}

const bothFormats = {
  video: 'video/webm',
  audio: 'audio/webm',
  usable: true,
}

describe('SegmentRecorder', () => {
  beforeEach(() => {
    FakeRecorder.instances = []
    FakeRecorder.behaviour = {}
    vi.stubGlobal('MediaRecorder', FakeRecorder)
    // The audio-only stream wraps the audio tracks; tag it so a test can
    // make the audio recorder and the video recorder behave differently.
    vi.stubGlobal(
      'MediaStream',
      class {
        kind = 'audio'
      },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  /** E9: ~1 Mbit/s of video, 64 kbit/s of speech. */
  it('caps the bitrate of both recordings', () => {
    new SegmentRecorder(fakeStream({ video: true }), bothFormats).start()
    const [audio, video] = FakeRecorder.instances
    expect(audio.options).toMatchObject({ audioBitsPerSecond: 64_000 })
    expect(video.options).toMatchObject({
      videoBitsPerSecond: 1_000_000,
      audioBitsPerSecond: 64_000,
    })
  })

  it('reports an encoder that fails mid-answer', () => {
    const onFailure = vi.fn()
    new SegmentRecorder(fakeStream({ video: true }), bothFormats, {
      onFailure,
    }).start()
    FakeRecorder.instances[1].onerror?.()
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('hands over chunks as they are recorded', () => {
    const onChunk = vi.fn()
    new SegmentRecorder(fakeStream({ video: true }), bothFormats, {
      onChunk,
    }).start()
    const [audio, video] = FakeRecorder.instances
    expect(audio.timeslice).toBe(CHUNK_INTERVAL_MS)
    audio.ondataavailable?.({ data: new Blob(['a']) })
    video.ondataavailable?.({ data: new Blob(['v']) })
    video.ondataavailable?.({ data: new Blob([]) })
    expect(onChunk.mock.calls.map(([track]) => track)).toEqual([
      'audio',
      'video',
    ])
  })

  it('says what it records once it starts, video only if there is some', () => {
    const onStart = vi.fn()
    new SegmentRecorder(fakeStream({ video: false }), bothFormats, {
      onStart,
    }).start()
    expect(onStart).toHaveBeenCalledWith({ audio: 'audio/webm', video: null })
  })

  it('reports an encoder that produces no audio, seconds in', async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    new SegmentRecorder(fakeStream({ video: false }), bothFormats, {
      onFailure,
    }).start()
    await vi.advanceTimersByTimeAsync(NO_DATA_TIMEOUT_SECONDS * 1000)
    expect(onFailure).toHaveBeenCalledOnce()
  })

  it('stays quiet about an encoder that is writing', async () => {
    vi.useFakeTimers()
    const onFailure = vi.fn()
    new SegmentRecorder(fakeStream({ video: false }), bothFormats, {
      onFailure,
    }).start()
    FakeRecorder.instances[0].ondataavailable?.({ data: new Blob(['a']) })
    await vi.advanceTimersByTimeAsync(NO_DATA_TIMEOUT_SECONDS * 2000)
    expect(onFailure).not.toHaveBeenCalled()
  })

  it('records audio alone from a stream with no camera', async () => {
    const recorder = new SegmentRecorder(fakeStream({ video: false }), bothFormats)
    recorder.start()
    expect(FakeRecorder.instances).toHaveLength(1)
    const recording = await recorder.stop()
    expect(recording.video).toBeNull()
    expect(recording.audio.size).toBeGreaterThan(0)
  })

  /**
   * E7. `stop()` waited for `onstop` with no limit: a recorder that never
   * fired it left "Saving your answer…" on screen for good.
   */
  it('gives up on a recorder that never stops', async () => {
    vi.useFakeTimers()
    FakeRecorder.behaviour.audio = 'hang'
    const recorder = new SegmentRecorder(fakeStream({ video: true }), bothFormats)
    recorder.start()
    const stopped = recorder.stop()
    const assertion = expect(stopped).rejects.toThrow('recorder did not stop')
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS)
    await assertion
  })

  it('keeps the answer when only the video fails to flush', async () => {
    vi.useFakeTimers()
    FakeRecorder.behaviour.camera = 'hang'
    const recorder = new SegmentRecorder(fakeStream({ video: true }), bothFormats)
    recorder.start()
    const stopped = recorder.stop()
    await vi.advanceTimersByTimeAsync(STOP_TIMEOUT_MS)
    const recording = await stopped
    expect(recording.video).toBeNull()
    expect(recording.audio.size).toBeGreaterThan(0)
  })

  it('refuses to hand over an empty take', async () => {
    FakeRecorder.behaviour.audio = 'empty'
    const recorder = new SegmentRecorder(fakeStream({ video: true }), bothFormats)
    recorder.start()
    await expect(recorder.stop()).rejects.toThrow('empty recording')
  })
})
